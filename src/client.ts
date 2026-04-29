// ValetClient — public entry point. Holds the customer-supplied
// fetchJwt callback and the (agentUuid, baseUrl) pair that scope every
// convo this client opens.
//
// ─── Design decisions (also load-bearing for non-JS SDK ports) ───────
//
// 1. Customer's backend mints the JWT, NOT us. The SDK never holds the
//    company's signing secret — the only acceptable place for the
//    secret is server-side. fetchJwt() is expected to hit a customer
//    endpoint like POST /api/valet/jwt that issues a fresh 15-min token.
//    Same pattern as Stripe's publishable-key + server-issued tokens.
//
// 2. agentUuid is configured at the client level because in practice a
//    customer integration is "embed Ally for this end-user" — same
//    agent for the lifetime of the page. If a future use case needs
//    multi-agent per page, agentUuid moves to openConvo().
//
// 3. baseUrl defaults to https://api.valet.red — production. Override
//    for staging / self-hosted. NO trailing slash — the SDK appends
//    paths starting with `/api/v2/...`.
//
// ─── Ports to other languages ────────────────────────────────────────
//
//   The same shape applies to a Python/Swift/Kotlin SDK:
//     * Caller provides a fetchJwt callable returning a fresh Bearer token.
//     * Client object captures (agentUuid, baseUrl, jwtSource).
//     * openConvo({convoUuid}) returns a Convo handle with .on() / .send() / .close().
//
//   The wire contract is the load-bearing thing — JS doesn't get to
//   redefine it. See plan: "Wire contract" + "Auth contract" sections.

import type { OpenConvoOptions, ValetClientConfig } from "./types"
import { JwtStore } from "./jwt"
import { Convo } from "./convo"

const DEFAULT_BASE_URL = "https://api.valet.red"

export class ValetClient {
  private readonly agentUuid: string
  private readonly baseUrl:   string
  private readonly jwt:       JwtStore

  constructor(cfg: ValetClientConfig) {
    if (!cfg.agentUuid) throw new Error("ValetClient: agentUuid is required")
    if (typeof cfg.fetchJwt !== "function") throw new Error("ValetClient: fetchJwt callback is required")
    this.agentUuid = cfg.agentUuid
    this.baseUrl   = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.jwt       = new JwtStore(cfg.fetchJwt)
  }

  // Open a per-convo SSE stream and return a typed handle.
  // The caller wires up event handlers BEFORE awaiting events:
  //
  //   const convo = await valet.openConvo({ convoUuid: "..." })
  //   convo.on("message", (m) => render(m))
  //   await convo.send("Hi")
  //
  // The convoUuid must already exist server-side. Convo creation lives
  // outside this SDK in v0.1 — customer's backend hits POST /agent_convos
  // before passing the uuid to the SDK. (A `valet.createConvo()`
  // helper is a v0.2 candidate.)
  async openConvo(opts: OpenConvoOptions): Promise<Convo> {
    if (!opts.convoUuid) throw new Error("openConvo: convoUuid is required")
    // Trigger an early JWT refresh so any auth issues surface during
    // `await openConvo` rather than silently in the background loop.
    await this.jwt.get()
    const convo = new Convo({
      agentUuid: this.agentUuid,
      convoUuid: opts.convoUuid,
      baseUrl:   this.baseUrl,
      jwt:       this.jwt
    })
    convo.start()
    return convo
  }
}

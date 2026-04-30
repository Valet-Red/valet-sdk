// ValetClient — public entry point. Holds the customer-supplied
// fetchJwt callback and the (agentId, baseUrl) pair that scope every
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
// 2. agentId is configured at the client level because in practice a
//    customer integration is "embed Ally for this end-user" — same
//    agent for the lifetime of the page. If a future use case needs
//    multi-agent per page, agentId moves to openConvo().
//
// 3. baseUrl defaults to https://api.valet.red — production. Override
//    for staging / self-hosted. NO trailing slash — the SDK appends
//    paths starting with `/api/v2/...`.
//
// ─── Ports to other languages ────────────────────────────────────────
//
//   The same shape applies to a Python/Swift/Kotlin SDK:
//     * Caller provides a fetchJwt callable returning a fresh Bearer token.
//     * Client object captures (agentId, baseUrl, jwtSource).
//     * openConvo({ convoId }) returns a Convo handle with .on() / .send() / .close().
//
//   The wire contract is the load-bearing thing — JS doesn't get to
//   redefine it. See plan: "Wire contract" + "Auth contract" sections.

import type { OpenConvoOptions, ValetClientConfig } from "./types"
import { JwtStore } from "./jwt"
import { Convo } from "./convo"

const DEFAULT_BASE_URL = "https://api.valet.red"

export class ValetClient {
  private readonly agentId: string
  private readonly baseUrl: string
  private readonly jwt:     JwtStore
  private readonly debug:   boolean

  constructor(cfg: ValetClientConfig) {
    if (!cfg.agentId) throw new Error("ValetClient: agentId is required")
    if (typeof cfg.fetchJwt !== "function") throw new Error("ValetClient: fetchJwt callback is required")
    this.agentId = cfg.agentId
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.debug   = cfg.debug === true
    this.jwt     = new JwtStore(cfg.fetchJwt, this.debug, cfg.fetchJwtTimeoutMs)
    if (this.debug) console.debug("[valet-sdk] ValetClient created", { agentId: this.agentId, baseUrl: this.baseUrl })
  }

  // Open a per-convo SSE stream and return a typed handle.
  // The caller wires up event handlers BEFORE awaiting events:
  //
  //   const convo = await valet.openConvo({ convoId: "..." })
  //   convo.on("message", (m) => render(m))
  //   await convo.send("Hi")
  async openConvo(opts: OpenConvoOptions): Promise<Convo> {
    if (!opts.convoId) throw new Error("openConvo: convoId is required")
    // Trigger an early JWT refresh so any auth issues surface during
    // `await openConvo` rather than silently in the background loop.
    await this.jwt.get()
    if (this.debug) console.debug("[valet-sdk] openConvo", { convoId: opts.convoId })
    const convo = new Convo({
      agentId: this.agentId,
      convoId: opts.convoId,
      baseUrl: this.baseUrl,
      jwt:     this.jwt,
      debug:   this.debug
    })
    convo.start()
    return convo
  }

  // Start a brand-new chat session. Always mints a fresh open convo —
  // we never reuse an existing one. Returns the new `convoId` the caller
  // can pass to `openConvo`. JWT-scoped: the appuser is whoever the
  // token was minted for; no `source_key` argument because the server
  // already knows who you are.
  //
  // Typical pattern:
  //   const { convoId } = await valet.startSession()
  //   const convo = await valet.openConvo({ convoId })
  async startSession(): Promise<{ convoId: string }> {
    const url = `${this.baseUrl}/api/v2/agents/${this.agentId}/sessions`
    if (this.debug) console.debug("[valet-sdk] startSession →", url)
    const jwt = await this.jwt.get()
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json"
      }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      if (this.debug) console.debug("[valet-sdk] startSession FAILED", { status: res.status, body: txt })
      throw new Error(`startSession failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
    }
    const body = await res.json() as { convo_id?: string }
    if (!body.convo_id) throw new Error("startSession: server returned no convo_id")
    if (this.debug) console.debug("[valet-sdk] startSession OK", { convoId: body.convo_id })
    return { convoId: body.convo_id }
  }

  // List this appuser's recent convos for this agent. Used by demo /
  // operator UIs that need a "your conversations" picker. Real customer
  // integrations usually don't need this — most apps render their own
  // list from their own DB.
  async listConvos(): Promise<Array<{ id: string; state: string; closed: boolean; last_message_at: string | null; created_at: string }>> {
    const url = `${this.baseUrl}/api/v2/agents/${this.agentId}/agent_convos`
    if (this.debug) console.debug("[valet-sdk] listConvos →", url)
    const jwt = await this.jwt.get()
    const res = await fetch(url, {
      method:  "GET",
      headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      if (this.debug) console.debug("[valet-sdk] listConvos FAILED", { status: res.status, body: txt })
      throw new Error(`listConvos failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
    }
    const body = await res.json() as { agent_convos?: Array<any> }
    if (this.debug) console.debug("[valet-sdk] listConvos OK", { count: body.agent_convos?.length ?? 0 })
    return body.agent_convos ?? []
  }
}

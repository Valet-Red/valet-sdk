# @valet/sdk

Browser SDK for Valet's per-convo Server-Sent Events stream + outbound `stream_message`. Embed an AI agent chat into your app with reconnect/dedupe/JWT-refresh handled for you.

```bash
npm install @valet/sdk
```

## Quickstart (3 steps)

### 1. Configure CORS for your origin

In the Valet portal, add your app's origin (e.g. `https://yourapp.com`) to your company's CORS allowlist. Without this the browser will refuse to connect.

### 2. Mint JWTs from your backend

The browser SDK never holds your company's signing secret. Your backend mints a 15-min HS256 JWT and exposes it via an authenticated endpoint:

```ts
// /api/valet/jwt — your backend
import jwt from "jsonwebtoken"

export async function GET(req: Request) {
  const user = await getCurrentUser(req) // your existing auth
  if (!user) return new Response("unauthorized", { status: 401 })

  const token = jwt.sign(
    {
      iss:         process.env.VALET_COMPANY_KEY,
      aud:         "valet-sdk",
      company_key: process.env.VALET_COMPANY_KEY,
      agent_uuid:  process.env.VALET_AGENT_UUID,
      source_key:  user.opaque_id,             // NOT user.email
      iat:         Math.floor(Date.now() / 1000),
      exp:         Math.floor(Date.now() / 1000) + 15 * 60
    },
    process.env.VALET_JWT_SECRET!,
    { algorithm: "HS256" }
  )
  return new Response(token)
}
```

`source_key` must NOT be an email. Use an opaque internal user ID. The Valet API rejects email-shaped values at the gate.

### 3. Drop in the SDK

```ts
import { ValetClient } from "@valet/sdk"

const valet = new ValetClient({
  agentUuid: "your-agent-uuid",
  fetchJwt:  () => fetch("/api/valet/jwt").then(r => r.text())
})

const convo = await valet.openConvo({ convoUuid: "..." })

convo.on("message",     ({ message }) => render(message))
convo.on("typing",      ({ label })   => showTyping(label))
convo.on("convo_state", ({ state })   => updateBadge(state))

await convo.send("Hi, I need help with my order")

// when the user navigates away
convo.close()
```

That's the whole integration. The SDK handles:

- One long-lived SSE connection per `(agent, convo)` pair
- JWT refresh — proactive at 5 min before expiry, forced on `auth_expiring` close
- Reconnect protocol — exponential backoff on errors, immediate reconnect on graceful server closes
- Reconcile fetch on every reconnect to fill any gap
- Message UUID dedupe — your handlers fire exactly once per message even after a reconcile
- Multi-tab safety — only one tab opens the SSE; others receive forwarded events via `BroadcastChannel`

## Public API

### `new ValetClient({ agentUuid, fetchJwt, baseUrl? })`

| Field | Type | Required | Description |
|---|---|---|---|
| `agentUuid` | `string` | yes | The agent your end-user is chatting with. |
| `fetchJwt`  | `() => Promise<string>` | yes | Returns a fresh JWT. SDK calls this on demand. |
| `baseUrl`   | `string` | no  | Defaults to `https://api.valet.red`. |

### `valet.openConvo({ convoUuid }) → Promise<Convo>`

Opens a per-convo SSE stream. Convo creation lives outside this SDK — your backend hits `POST /api/v2/agents/{agent_uuid}/agent_convos` to get a uuid first.

### `convo.on(event, handler) → unsubscribe`

Typed event subscription. Returns an unsubscribe function.

| Event | Payload | When it fires |
|---|---|---|
| `message`     | `MessageEvent`     | a new convo message persisted (any participant) |
| `typing`      | `TypingEvent`      | someone started/stopped typing |
| `convo_state` | `ConvoStateEvent`  | the convo's state flipped (open → escalated → resolved → ...) |
| `ready`       | `ReadyEvent`       | stream is live (fires once per connect) |
| `closed`      | `ClosedEvent`      | server is closing the stream (you don't usually need to handle this — SDK reconnects for you) |
| `error`       | `{error, phase}`   | non-recoverable error |

### `convo.send(text) → Promise<void>`

POSTs a user message. Fire-and-forget — the agent's reply arrives via the `message` event.

### `convo.close()`

Aborts the SSE stream and stops reconnect. Call this when your chat UI unmounts.

## Design notes

The SDK enforces a security and correctness contract that's worth understanding:

- **JWT auth, no API-key fallback.** Your company API key never enters the browser. The SDK exclusively uses Bearer JWTs minted by your backend.
- **Per-convo isolation.** The server filters every event by convo ownership; an end-user's stream cannot see another user's events.
- **`source_key` is rejected if email-shaped.** Use opaque IDs. The privacy posture only works if you don't put PII in identifiers.
- **15-min JWT lifetime.** Long enough for the SDK's 5-min `auth_expiring` warning to be useful; short enough to limit replay risk.
- **Per-(appuser, agent) cap of 2.** Multi-tab is handled via tab-leader election. A 3rd concurrent connection gets 429 with `Retry-After: 30`.

For the full design rationale (reconnect protocol, replay model, capacity, observability), see `docs/platform/realtime-events.mdx` in the Valet repo.

## Examples

See `examples/`:
- `vanilla.html` — drop-in HTML page
- `react.tsx` — minimal React component
- `nextjs/page.tsx` — Next.js App Router

## License

Proprietary. See LICENSE (TODO).

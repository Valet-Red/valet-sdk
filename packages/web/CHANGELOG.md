# Changelog

All notable changes to `@valet.red/sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-30

**Breaking:** V2 Client paths drop the `/agents/:agent_uuid/` segment. `agent_uuid` is already a JWT claim — repeating it in the URL was tautological. Update partner backends (or use the SDK, which handles this for you).

### Changed

- **URL paths**: `/api/v2/agents/:agent_uuid/sessions` → `/api/v2/sessions`. `/api/v2/agents/:agent_uuid/agent_convos` → `/api/v2/agent_convos`. `/api/v2/agents/:agent_uuid/agent_convos/:convo_uuid/...` → `/api/v2/agent_convos/:convo_uuid/...`. The SDK's `startSession()`, `listConvos()`, `convo.send()`, `convo.uploadFiles()`, and SSE subscription all hit the new paths automatically.
- Wire (event payloads, response shapes, JWT claims) is unchanged. No event handler updates needed.

### Update guide

1. Bump the dep to `^0.3.0`.
2. Bump `@valet.red/sdk-core` to `^0.3.0` if you import it directly.
3. If you make raw fetches to V2 (without the SDK), update your URL templates to drop `/agents/:agent_uuid/`.

## [0.2.0] - 2026-04-30

Tracks the Valet V2 wire-shape changes that landed alongside the new `/api/v2/s2s/...` server-driven surface. Minor bump (not patch) because `TypingEvent`'s literal types changed and `startSession()` returns a richer object. Update guide at the bottom.

### Added

- **`TurnDoneEvent`** — fires on the per-convo channel after each TurnLoop turn ends (success / blocked / errored). Closes the gap where consumers had no signal that "the LLM finished and isn't replying" and had to infer from a `message` arrival + `typing stop` race. Reason ∈ `ok` / `blocked` / `rate_limited` / `closed` / `unavailable` / `temporary_failure`. Carries `retry_after_seconds` when rate-limited. Subscribe via `convo.on("turn_done", evt => …)`.
- **Server-emitted `error` event** — sanitized failure frame from the per-convo channel when TurnLoop raises. Forwarded to the same `convo.on("error", …)` listener as SDK-internal errors; consumers disambiguate by the presence of `reason` (server) vs `error` (SDK-internal).
- **`ConvoStateEvent.closed_user_message`** — server-formatted ready-to-render copy for closed states ("A teammate is taking it from here.", dated lockout strings). `null` for `state: "open"`.
- **Two-field `TypingEvent`**: `{kind, state, label, convo_id}`. `kind` ∈ `thinking` (AI waiting on LLM) / `typing` (operator actively producing). `state` ∈ `start` / `stop`. Auto-clear rule: any `message` / `turn_done` / `error` / `convo_state` event also clears the indicator.
- **`startSession()`** now returns `{convoId, attachmentPolicy, lockout}`. Saves a round-trip for clients that need to render upload UI or a lockout banner on chat open.
- **HTTP 429 + `Retry-After` on `stream_message`** — `convo.send()` now throws an `Error` tagged with `retryAfterSeconds` and `status: 429` when the server rate-limits the turn. Lets callers render "try again in N seconds" UX without parsing canned reply text.

### Changed

- `TypingEvent.state` literal type narrowed to `"start" | "stop"` (was `"start" | "stop"` — same wire values, but `kind` is now the activity discriminator). Backward-compatible at runtime; strict TypeScript callers should switch on `kind` rather than parsing the label string.
- `startSession()` return type widened from `{convoId}` to `StartSessionResult`. Old destructuring (`const { convoId } = await valet.startSession()`) keeps working.

### Update guide

Most consumers won't need code changes — the wire is additive at runtime. If you're upgrading from 0.1.x:

1. Bump the dep to `^0.2.0`.
2. To consume new features, add handlers: `convo.on("turn_done", evt => …)` and check `evt.reason` on `error` for the server-emitted shape.
3. To use the richer `startSession` response, destructure the new fields: `const { convoId, attachmentPolicy, lockout } = await valet.startSession()`.

## [0.1.3] - 2026-04-29

### Added

- **`pauseOnHidden` (default `true`)** — each `Convo` now closes its SSE stream on `document.visibilitychange → hidden` and reopens on `visible`. Eliminates the laptop-sleep / backgrounded-tab zombie-slot scenario that could pin the per-(appuser, agent) connection cap of 2 for up to an hour. Cost: a brief disconnect on tab-switch (typically <300 ms reconnect on return). Set `pauseOnHidden: false` on `ValetClientConfig` to keep streams alive across visibility changes (the legacy 0.1.2 behavior).
- New `Convo.pause()` / `Convo.resume()` methods exposed for hosts that want to drive suspension manually instead of (or in addition to) the visibility listener. ([src/convo.ts](src/convo.ts))

## [0.1.2] - 2026-04-29

### Added

- npm package metadata: `repository`, `homepage`, and `bugs` fields point at https://github.com/Valet-Red/valet-sdk so the npm package page links back to source and issue tracker.

## [0.1.1] - 2026-04-29

First public npm release as `@valet.red/sdk` under MIT license.

### Fixed

- `Retry-After` on 429 was incorrectly clamped — a server that returned `Retry-After: 600` would put the client to sleep for 10 minutes instead of being capped at the 30s `MAX_DELAY_MS`. ([src/reconnect.ts](src/reconnect.ts))
- Persistent 401s from the SSE stream no longer loop forever. After 3 consecutive 401s, the SDK trips a circuit breaker and emits an `error` event with `phase: "auth"` so the host app can surface the failure. The counter resets on the next successful `ready` frame. ([src/convo.ts](src/convo.ts))
- `fetchJwt()` is now hard-capped (default 10s) so a hung partner mint endpoint can't block the convo indefinitely. Override via the new `fetchJwtTimeoutMs` config. ([src/jwt.ts](src/jwt.ts))
- Tab-leader election no longer false-elects a second tab as leader. The previous initial-election window (300ms) was shorter than the leader's heartbeat interval (1s), so a freshly-opened tab could fire its election before catching any heartbeat from the existing leader. The follower now broadcasts a `query_leader` probe on start; the existing leader replies with an immediate heartbeat. ([src/tab-leader.ts](src/tab-leader.ts))
- Convo unit tests were asserting against stale wire-type field names (`uuid` / `agentUuid` / `convoUuid`); they masked a pre-existing dedupe regression for nine months because the field they passed in didn't match what `MessageDedupe` reads. Tests now use the canonical `id` / `agentId` / `convoId` names from `types.ts`. ([test/convo.test.ts](test/convo.test.ts))

### Changed

- Package renamed from `@valet/sdk` → `@valet.red/sdk` (the `@valet` npm scope was unavailable; `@valet.red` matches the company's domain).
- License changed from `UNLICENSED` to `MIT`.
- Fixed broken `main` / `module` / `exports` paths in `package.json` — they pointed at filenames tsup never produced. ESM consumers are now served `dist/index.js`, CJS consumers `dist/index.cjs`.
- `ValetClientConfig` gains an optional `fetchJwtTimeoutMs: number` field. ([src/types.ts](src/types.ts))

### Documentation

- README quickstart now matches the actual API surface (`agentId`/`convoId`, not `agentUuid`/`convoUuid`) and shows the `startSession()` → `openConvo()` pairing.
- README JWT-mint example now uses `company_api_key` (matches the server's `Auth::VerifyAppuserJwt` claim name).

## [0.1.0] - 2026-04-29

Initial release. Browser-only SDK for Valet's per-convo SSE event stream + outbound `stream_message`.

### Added

- `ValetClient` with `startSession()`, `openConvo()`, `listConvos()`.
- `Convo` with `on()` / `send()` / `uploadFiles()` / `close()`.
- JWT cache + proactive refresh (5 min before `exp`).
- Reconnect protocol with close-reason switch and exponential backoff (250ms → 30s).
- Per-message UUID dedupe across SSE + reconcile fetch.
- Multi-tab leader election via `BroadcastChannel`.
- Typed event vocabulary: `message`, `typing`, `convo_state`, `ready`, `closed`, `error`.

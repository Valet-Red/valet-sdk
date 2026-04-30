# Changelog

All notable changes to `@valet.red/sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

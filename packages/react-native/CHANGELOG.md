# Changelog

All notable changes to `@valet.red/sdk-react-native` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-30

**Breaking:** V2 Client paths drop the `/agents/:agent_uuid/` segment, matching `@valet.red/sdk@0.3.0`. See [packages/web/CHANGELOG.md](../web/CHANGELOG.md) for the full rationale and update guide.

## [0.2.0] - 2026-04-30

Tracks the Valet V2 wire-shape changes. Same surface additions as `@valet.red/sdk@0.2.0` — see [packages/web/CHANGELOG.md](../web/CHANGELOG.md) for the full set.

### Added

- `TurnDoneEvent` and server-emitted `error` event forwarded through `convo.on(...)`. Critical: the RN transport's `namedEvents` array is a hardcoded list — older builds silently dropped any event name not in the list, including `turn_done` and `error`. This release adds them.
- Two-field `TypingEvent` (`kind` + `state`).
- `ConvoStateEvent.closed_user_message`.
- `startSession()` returns `{convoId, attachmentPolicy, lockout}`.
- HTTP 429 + `Retry-After` parsing on `stream_message` (matching the web SDK's behavior).

## [0.1.1] - 2026-04-30

### Fixed

- AppState lifecycle was broken in 0.1.0 because the `react-native` import was wrapped in a runtime `require()` that tsup's minifier mangled. Metro couldn't statically resolve the call, throwing _"Requiring unknown module 'react-native'"_ on convo start. SSE messaging was unaffected (the popup could be dismissed and pings continued), but background/foreground pause-resume never wired up. Now imports `AppState` and its types from `react-native` at the top of the module — the canonical pattern for RN libraries.

## [0.1.0] - 2026-04-30

Initial release. React Native SDK for Valet's per-convo SSE event stream + outbound `stream_message`. Same API surface as `@valet.red/sdk` (browser), adapted for native with [`react-native-sse`](https://github.com/binaryminds/react-native-sse) transport, `AppState` lifecycle, and no tab-leader (single-process).

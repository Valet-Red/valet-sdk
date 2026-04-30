# @valet.red/sdk-core

Platform-agnostic primitives shared by the Valet platform SDKs:

- **[`@valet.red/sdk`](https://www.npmjs.com/package/@valet.red/sdk)** — browser SDK
- **[`@valet.red/sdk-react-native`](https://www.npmjs.com/package/@valet.red/sdk-react-native)** — React Native SDK

You probably don't want to install this directly — install one of the platform SDKs and you'll get this as a transitive dependency.

## What's in here

- `JwtStore` — JWT cache + concurrent-refresh dedupe + expiry-aware proactive refresh
- `MessageDedupe` — bounded LRU set for message-uuid dedupe across SSE + reconcile-fetch
- `ReconnectPolicy` — close-reason → reconnect-delay state machine (250ms → 30s exponential backoff, immediate-reconnect on graceful close, Retry-After on 429)
- Wire-format types — `Message`, `MessageEvent`, `TypingEvent`, `ConvoStateEvent`, `ReadyEvent`, `ClosedEvent`, `PingEvent`, `AnyServerEvent`, `CloseReason`, `ConvoState`, `ValetClientConfig`, `OpenConvoOptions`

These are the things that have nothing to do with how SSE events are delivered or how visibility lifecycles are detected — they're pure logic that any platform SDK can build on top of.

## Why a separate package

The browser and React Native SDKs share ~70% of their logic but have different transport layers (`@microsoft/fetch-event-source` vs `react-native-sse`) and lifecycle adapters (`document.visibilitychange` vs `AppState`). Splitting the shared layer into its own package keeps the wire contract, JWT semantics, dedupe rules, and reconnect protocol in one place — so a server-side change can't drift between web and native.

## Direct usage (rare)

If you're building a Valet integration in a runtime that isn't browser or React Native — Node CLI, server bridge, custom mobile framework — you can install this package and assemble your own client around the primitives:

```ts
import { JwtStore, MessageDedupe, ReconnectPolicy, type AnyServerEvent } from "@valet.red/sdk-core"

const jwt = new JwtStore(() => mintTokenFromBackend())
const dedupe = new MessageDedupe()
const reconnect = new ReconnectPolicy()

// You provide the SSE transport. Pipe parsed events into your handler;
// the protocol contract is documented at:
// https://app.valet.red/docs/platform/realtime-events
```

For most use cases, prefer the platform SDKs.

## License

MIT. See [LICENSE](LICENSE).

## Source

[github.com/Valet-Red/valet-sdk](https://github.com/Valet-Red/valet-sdk)

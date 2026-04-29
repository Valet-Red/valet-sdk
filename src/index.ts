// Public exports for @valet/sdk.
//
// What ships in v0.1:
//   - ValetClient          — entry point; holds (agentId, baseUrl, jwt).
//   - Convo                — per-convo handle; .on() / .send() / .close().
//   - typed event payloads (Message, MessageEvent, TypingEvent, ConvoStateEvent, ...).
//
// What does NOT ship in v0.1 (deferred to v0.2+):
//   - createConvo()        — convo lifecycle helper (currently customer-backend job).
//   - per-turn token streaming on .send() — fire-and-forget today; ambient
//     /events SSE delivers the agent's reply.
//   - Browser-EventSource fallback — we're fetch+ReadableStream-only.
//   - Persistence — all dedupe state is in-memory, lost on tab close.

export { ValetClient } from "./client"
export { Convo } from "./convo"

export type {
  Message,
  MessageFile,
  Participant,
  MessageEvent,
  TypingEvent,
  ConvoStateEvent,
  ReadyEvent,
  ClosedEvent,
  PingEvent,
  AnyServerEvent,
  CloseReason,
  ConvoState,
  ClientEventName,
  ClientEventMap,
  ValetClientConfig,
  OpenConvoOptions,
  ChaosConfig
} from "./types"

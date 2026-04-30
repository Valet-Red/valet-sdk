// Wire-format types for events that flow over /api/v2/.../events.
// These are 1:1 with the server's broadcast payloads — see
// app/models/agent_message.rb#event_feed_payload (and friends) on the
// Valet repo.
//
// ─── Why these are first-class types ─────────────────────────────────
//
// 1. Customers writing TypeScript get autocomplete + compile-time
//    safety on event handlers. The event vocabulary (message / typing
//    / convo_state) has stable, narrow shapes — typing them gives
//    customers the same experience as a typed RPC SDK.
//
// 2. The server's wire format is the source of truth. If you find
//    yourself wanting to "smooth out" the JSON shape on the way to
//    the customer, DON'T. Stay 1:1 with the wire so customers reading
//    the API reference and the SDK types get the same answers.
//
// 3. Event tagging via discriminated `type` field. Even though the
//    SSE `event:` line is the actual discriminator on the wire, we
//    inject `type` on the parsed payload (sse.ts) so downstream
//    switch-by-type works on a self-describing object. Every
//    server-emitted JSON payload also includes `type` natively, so
//    this is a belt-and-braces measure.
//
// ─── Porting notes ───────────────────────────────────────────────────
//
//   Other typed languages (Swift / Kotlin / Rust): represent these as
//   sum types / sealed classes / enums-with-payload. Native
//   discriminator on `type` field; same wire-format JSON.
//
//   Untyped languages (Python without TypedDict, Ruby, etc.): document
//   the shape; provide accessors (event["message"]["uuid"]) but don't
//   try to reify into objects.

export interface Participant {
  // Public external id for this participant (`Agent#uuid`, `User#uuid`,
  // or `Appuser#source_key`). Stable across messages — use it to cache
  // an avatar bitmap or hide repeated names on consecutive bubbles.
  id: string
  kind: "ai_agent" | "appuser" | "human_agent"
  name: string
  photo_url: string
  initial: string
}

export interface MessageFile {
  url: string
  filename: string
  content_type: string
  byte_size: number
}

export interface Message {
  id: string
  content: string
  from: "appuser" | "ai_agent" | "human_agent"
  turn_number: number
  created_at: string
  participant: Participant | null
  files: MessageFile[]
}

export interface ReadyEvent {
  type: "ready"
  conn_id: string
}

export interface MessageEvent {
  type: "message"
  action: "create"
  agent_id: string
  convo_id: string
  message: Message
  // True only on messages emitted by the reconcile fetch (i.e. loaded
  // from convo history on first connect / reconnect). Live broadcasts
  // omit this flag. Consumers can filter on this to keep history out of
  // a "live events" debug panel while still rendering the bubble.
  from_reconcile?: true
}

// Two-field typing event:
//
//   - `kind`  is the activity. `thinking` = the agent has sent off to
//     the LLM and is waiting for a reply (no tokens yet). `typing` =
//     actively producing — humans always; future AI streaming.
//   - `state` is the lifecycle. `start` = begin showing the indicator.
//     `stop` = clear it.
//
// Auto-clear rule: any `message`, `turn_done`, `error`, or `convo_state`
// event for the same convo also clears the indicator client-side. The
// explicit `state: "stop"` is a safety net for "operator started typing
// then walked away without sending."
export interface TypingEvent {
  type: "typing"
  kind: "thinking" | "typing"
  state: "start" | "stop"
  label: string
  convo_id: string
}

export type ConvoState =
  | "open"
  | "escalated"
  | "resolved"
  | "auto_resolved"
  | "assumed_resolved"
  | "rage_locked"
  | "attempted_hack"
  | "pending_feedback"

export interface ConvoStateEvent {
  type: "convo_state"
  agent_id: string
  convo_id: string
  state: ConvoState
  prev_state: ConvoState
  // Server-formatted ready-to-render copy for closed states ("A teammate
  // is taking it from here.", dated lockout strings, etc.). `null` for
  // `state: "open"`.
  closed_user_message: string | null
}

export interface PingEvent {
  type: "ping"
}

// Server signals every TurnLoop turn end (success / blocked / errored)
// so SDK consumers can finalize per-turn UI state without inferring
// from a `message` arrival + `typing stop` race. `retry_after_seconds`
// is only set on rate-limited turns (mirrors the HTTP 429 + Retry-After
// on `stream_message`).
export interface TurnDoneEvent {
  type: "turn_done"
  convo_id: string
  reason: "ok" | "blocked" | "rate_limited" | "closed" | "unavailable" | "temporary_failure"
  at: number
  retry_after_seconds?: number
}

// Sanitized failure event from the per-convo channel — fired when
// TurnLoop raises. Internal class/message stays in server logs +
// Rollbar; consumers see only the coarse reason. NOT to be confused
// with the SDK-internal `error` listener (which surfaces transport
// failures via {error, phase}). Both shapes flow through `convo.on("error", …)`;
// disambiguate by the presence of `reason` (server) vs `error` (SDK).
export interface ServerErrorEvent {
  type: "error"
  convo_id: string
  reason: "temporary_failure"
  at: number
}

export type CloseReason =
  | "server_cap"
  | "shutdown"
  | "auth_expiring"
  | "stalled"

export interface ClosedEvent {
  type: "closed"
  reason: CloseReason
}

export type AnyServerEvent =
  | ReadyEvent
  | MessageEvent
  | TypingEvent
  | ConvoStateEvent
  | TurnDoneEvent
  | ServerErrorEvent
  | PingEvent
  | ClosedEvent

// Public event names a client can subscribe to via convo.on(...)
export type ClientEventName = "message" | "typing" | "convo_state" | "turn_done" | "ready" | "closed" | "error"

// Either shape can flow through `error`:
//   - SDK-internal: `{error: Error, phase: "stream"|"fetch"|"auth"}`
//   - Server-emitted: `ServerErrorEvent`
// Disambiguate by `"reason" in evt` (server) vs `"error" in evt` (SDK).
export type AnyErrorEvent =
  | { error: Error; phase: "stream" | "fetch" | "auth" }
  | ServerErrorEvent

export interface ClientEventMap {
  message:     MessageEvent
  typing:      TypingEvent
  convo_state: ConvoStateEvent
  turn_done:   TurnDoneEvent
  ready:       ReadyEvent
  closed:      ClosedEvent
  error:       AnyErrorEvent
}

// Returned by ValetClient#startSession. `attachmentPolicy` and `lockout`
// are surfaced so the SDK caller can render upload UI + lockout banners
// without an extra round-trip.
export interface StartSessionResult {
  convoId: string
  attachmentPolicy: AttachmentPolicy
  lockout: LockoutSnapshot
}

export interface AttachmentPolicy {
  max_files_per_message: number
  max_files_per_convo:   number
  max_file_size_bytes:   number
  allowed_mime_types:    string[]
}

export interface LockoutSnapshot {
  locked_out:    boolean
  expires_at:    string | null
  permanent:     boolean
  reason:        "permanent" | "rage" | "hack" | null
  user_message:  string | null
}

export interface ValetClientConfig {
  agentId: string
  fetchJwt: () => Promise<string> | string
  baseUrl?: string
  // When true, the SDK logs lifecycle events (JWT fetch, SSE open/close,
  // every received event, reconnect decisions, errors) to `console.debug`
  // with a `[valet-sdk]` prefix. Off by default — turning it on in
  // production is fine but noisy. Designed for local development.
  debug?: boolean
  // Hard cap on a single fetchJwt() call. Defaults to 10s. If the
  // partner's mint endpoint hangs, the SDK fails the refresh rather than
  // blocking the convo indefinitely.
  fetchJwtTimeoutMs?: number
  // When true (default), each opened Convo closes its SSE stream on
  // `document.visibilitychange → hidden` and reopens on `visible`. This
  // is the recommended setting — it eliminates the laptop-sleep zombie-
  // slot scenario at the cost of a brief disconnect on tab-switch.
  // Set to false to keep streams alive across visibility changes.
  pauseOnHidden?: boolean
}

export interface OpenConvoOptions {
  convoId: string
}

// Internal chaos hooks — used by ally_dash's "exercise reconnect" mode
// to simulate adverse network conditions in tests / staging. Off by
// default; production callers should not set these.
export interface ChaosConfig {
  dropEvery?: number
  stallFor?: number
  forceReconnect?: boolean
}

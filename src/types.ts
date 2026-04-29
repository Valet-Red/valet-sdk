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
  uuid: string
  content: string
  role: string
  from: "appuser" | "ai_agent" | "human_agent"
  turn_number: number
  created_at: string
  participant_id: number | null
  participant_type: string | null
  participant_key: string | null
  participant: Participant | null
  files: MessageFile[]
  agent_convo_uuid: string
}

export interface ReadyEvent {
  type: "ready"
  at: number
  conn_id: string
}

export interface MessageEvent {
  type: "message"
  action: "create"
  at: number
  agent_uuid: string
  convo_uuid: string
  message: Message
}

export interface TypingEvent {
  type: "typing"
  at: number
  state: "start" | "stop"
  label: string
  convo_uuid: string
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
  at: number
  agent_uuid: string
  convo_uuid: string
  state: ConvoState
  prev_state: ConvoState
}

export interface PingEvent {
  type: "ping"
  at: number
}

export type CloseReason =
  | "server_cap"
  | "shutdown"
  | "auth_expiring"
  | "stalled"

export interface ClosedEvent {
  type: "closed"
  at: number
  reason: CloseReason
}

export type AnyServerEvent =
  | ReadyEvent
  | MessageEvent
  | TypingEvent
  | ConvoStateEvent
  | PingEvent
  | ClosedEvent

// Public event names a client can subscribe to via convo.on(...)
export type ClientEventName = "message" | "typing" | "convo_state" | "ready" | "closed" | "error"

export interface ClientEventMap {
  message:     MessageEvent
  typing:      TypingEvent
  convo_state: ConvoStateEvent
  ready:       ReadyEvent
  closed:      ClosedEvent
  error:       { error: Error; phase: "stream" | "fetch" | "auth" }
}

export interface ValetClientConfig {
  agentUuid: string
  fetchJwt: () => Promise<string> | string
  baseUrl?: string
}

export interface OpenConvoOptions {
  convoUuid: string
}

// Internal chaos hooks — used by ally_dash's "exercise reconnect" mode
// to simulate adverse network conditions in tests / staging. Off by
// default; production callers should not set these.
export interface ChaosConfig {
  dropEvery?: number
  stallFor?: number
  forceReconnect?: boolean
}

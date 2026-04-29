// Convo — one open subscription to /api/v2/.../events. Owns the
// reconnect loop, the JWT lifecycle, the dedupe set, and the typed
// event handler registry.

import type {
  AnyServerEvent,
  ChaosConfig,
  ClientEventMap,
  ClientEventName,
  ClosedEvent,
  Message,
  ReadyEvent
} from "./types"
import { JwtStore } from "./jwt"
import { MessageDedupe } from "./dedupe"
import { ReconnectPolicy, sleep } from "./reconnect"
import { connectSse } from "./sse"
import { TabLeader } from "./tab-leader"

interface ConvoConfig {
  agentId: string
  convoId: string
  baseUrl: string
  jwt:     JwtStore
  debug?:  boolean
}

type Handler<E extends ClientEventName> = (data: ClientEventMap[E]) => void

export class Convo {
  // Public chaos hooks — used by ally_dash to drive reconnect/refetch
  // testing under adverse network conditions. Off by default.
  _chaos: ChaosConfig = {}

  private handlers: { [K in ClientEventName]?: Handler<K>[] } = {}
  private aborter: AbortController | null = null
  private closed = false
  private firstReady = true
  private reconnect = new ReconnectPolicy()
  private dedupe = new MessageDedupe()
  private leader: TabLeader

  constructor(private readonly cfg: ConvoConfig) {
    const leaderKey = `${cfg.agentId}:${cfg.convoId}`
    this.leader = new TabLeader(leaderKey)
  }

  private log(...args: unknown[]): void {
    if (this.cfg.debug) console.debug("[valet-sdk]", `[${this.cfg.convoId.slice(0, 8)}]`, ...args)
  }



  // Subscribe to a typed event. Returns an unsubscribe function.
  on<E extends ClientEventName>(event: E, handler: Handler<E>): () => void {
    const list = (this.handlers[event] ??= []) as Handler<E>[]
    list.push(handler)
    return () => {
      const idx = list.indexOf(handler)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  // POST a user message. Default fire-and-forget — the server pushes
  // the agent's reply over /events. Pass `files` to attach uploads:
  // the SDK uploads them first, then finalizes the draft via
  // stream_message with the returned `message_id`.
  async send(text: string, opts: { files?: File[] } = {}): Promise<void> {
    let messageId: string | undefined
    const files = opts.files ?? []
    if (files.length > 0) {
      messageId = await this.uploadFiles(files)
    }

    const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentId}/agent_convos/${this.cfg.convoId}/stream_message`
    const jwt = await this.cfg.jwt.get()
    const body: Record<string, unknown> = { text }
    if (messageId) body.message_id = messageId
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      const err = new Error(`stream_message failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
      this.log("send FAILED", { status: res.status, body: txt })
      this.emit("error", { error: err, phase: "fetch" })
      throw err
    }
    this.log("send OK", { messageId })
    // Drain the body without parsing — the ambient feed delivers the
    // agent's reply via /events, and the per-turn token frames are not
    // surfaced to the customer in v0.1.
    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    }
  }

  // Upload one or more files as a draft outgoing message. Returns the
  // server-issued `message_id` so the caller can pass it to a later
  // `send()` (or to a fresh `stream_message`) to finalize the draft.
  // Most callers should just pass `files` to `send()` instead — that
  // wraps this for the common "text + attachments in one go" flow.
  async uploadFiles(files: File[]): Promise<string> {
    const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentId}/agent_convos/${this.cfg.convoId}/upload_file`
    this.log("uploadFiles →", { count: files.length })
    const jwt = await this.cfg.jwt.get()
    const fd = new FormData()
    for (const f of files) fd.append("files[]", f, f.name)
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${jwt}` },
      body:    fd
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      this.log("uploadFiles FAILED", { status: res.status, body: txt })
      const err = new Error(`uploadFiles failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
      this.emit("error", { error: err, phase: "fetch" })
      throw err
    }
    const body = await res.json() as { message_id?: string }
    if (!body.message_id) throw new Error("uploadFiles: server returned no message_id")
    this.log("uploadFiles OK", { messageId: body.message_id })
    return body.message_id
  }

  // Open the SSE stream and run the reconnect loop until close().
  start(): void {
    this.log("start")
    this.leader.start({
      onBecameLeader:   () => { this.log("became SSE leader"); this.runStreamLoop() },
      onForwardedEvent: (data) => this.emitForwarded(data)
    })
  }

  close(): void {
    this.log("close")
    this.closed = true
    this.aborter?.abort()
    this.aborter = null
    this.leader.stop()
  }

  // Internal: leader runs the actual SSE loop; followers receive
  // forwarded events via BroadcastChannel.
  async runStreamLoop(): Promise<void> {
    while (!this.closed) {
      this.aborter = new AbortController()
      const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentId}/agent_convos/${this.cfg.convoId}/events`
      let lastClose: ClosedEvent["reason"] | null = null
      let httpStatus: number | undefined
      let retryAfter: number | undefined

      try {
        this.log("SSE connecting →", url)
        const jwt = await this.cfg.jwt.get()
        await connectSse({
          url,
          headers: {
            "Authorization": `Bearer ${jwt}`,
            "Accept":        "text/event-stream"
          },
          signal:  this.aborter.signal,
          onOpen:  () => this.log("SSE opened"),
          onEvent: (evt) => {
            this.log("SSE event", evt)
            const captured = this.handleEvent(evt)
            if (captured?.kind === "closed") lastClose = captured.reason
          },
          onError: (err, status, ra) => {
            httpStatus = status
            retryAfter = ra
            this.log("SSE error", { status, retryAfter: ra, message: err instanceof Error ? err.message : String(err) })
            if (status === 401) {
              // Caller refreshes JWT before next iteration.
              void this.cfg.jwt.refresh()
            }
          }
        })
      } catch (e) {
        // connectSse re-throws onError to terminate; we handle below.
        this.log("SSE threw", e instanceof Error ? e.message : e)
      }

      if (this.closed) break

      let decision
      if (httpStatus !== undefined) {
        decision = this.reconnect.decideOnError(httpStatus, retryAfter)
      } else {
        decision = this.reconnect.decideOnClose(lastClose)
      }
      this.log("reconnect decision", { httpStatus, lastClose, ...decision })
      if (!decision.shouldReconnect) {
        this.emit("error", { error: new Error("non-recoverable close"), phase: "stream" })
        break
      }
      if (decision.delayMs > 0) await sleep(decision.delayMs)
    }
  }

  // Returns kind="closed" so the caller knows to record the reason.
  handleEvent(evt: AnyServerEvent): { kind: "closed"; reason: ClosedEvent["reason"] } | null {
    switch (evt.type) {
      case "ready":
        this.reconnect.noteReady()
        this.emit("ready", evt)
        // Always reconcile on `ready` — on first connect this loads any
        // pre-existing messages (e.g. an agent greeting seeded at convo
        // creation), and on reconnects it fills the live-broadcast gap.
        // The dedupe set keeps each message from emitting twice.
        void this.reconcileFetch()
        this.firstReady = false
        return null
      case "message": {
        const m: Message = evt.message
        if (!this.dedupe.observe(m.id)) return null
        this.emit("message", evt)
        this.leader.forwardEvent(evt)
        return null
      }
      case "typing":
        this.emit("typing", evt)
        this.leader.forwardEvent(evt)
        return null
      case "convo_state":
        this.emit("convo_state", evt)
        this.leader.forwardEvent(evt)
        return null
      case "ping":
        return null
      case "closed":
        this.emit("closed", evt)
        return { kind: "closed", reason: evt.reason }
      default:
        return null
    }
  }

  // Reconcile fetch on every reconnect after the first connect.
  // Source-of-truth refresh — the SDK contract says between-turn
  // events are best-effort delivery and clients must reconcile via
  // fetch on reconnect.
  async reconcileFetch(): Promise<void> {
    try {
      const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentId}/agent_convos/${this.cfg.convoId}`
      this.log("reconcileFetch →", url)
      const jwt = await this.cfg.jwt.get()
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" }
      })
      if (!res.ok) {
        this.log("reconcileFetch FAILED", { status: res.status })
        return // best-effort
      }
      const body = await res.json() as { messages?: Message[] }
      this.log("reconcileFetch OK", { messages: body.messages?.length ?? 0 })
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (this.dedupe.observe(m.id)) {
            // Synthesize a `message` event — same shape as a live broadcast.
            // `from_reconcile: true` lets consumers filter history out of
            // live-event views (e.g. an event-log debug panel) while still
            // rendering the message bubble in the chat panel.
            this.emit("message", {
              type: "message",
              action: "create",
              agent_id: this.cfg.agentId,
              convo_id: this.cfg.convoId,
              message: m,
              from_reconcile: true
            })
          }
        }
      }
    } catch (e) {
      this.emit("error", { error: e instanceof Error ? e : new Error(String(e)), phase: "fetch" })
    }
  }

  emitForwarded(data: unknown): void {
    if (!data || typeof data !== "object") return
    const evt = data as AnyServerEvent
    if (evt.type === "message") this.emit("message", evt)
    else if (evt.type === "typing") this.emit("typing", evt)
    else if (evt.type === "convo_state") this.emit("convo_state", evt)
  }

  emit<E extends ClientEventName>(event: E, data: ClientEventMap[E]): void {
    const list = this.handlers[event] as Handler<E>[] | undefined
    if (!list) return
    for (const h of list) {
      try {
        h(data)
      } catch (e) {
        if (this.cfg.debug) console.debug("[valet-sdk] handler threw for", event, e)
      }
    }
  }
}

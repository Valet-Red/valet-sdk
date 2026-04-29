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
  agentUuid:  string
  convoUuid:  string
  baseUrl:    string
  jwt:        JwtStore
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
    const leaderKey = `${cfg.agentUuid}:${cfg.convoUuid}`
    this.leader = new TabLeader(leaderKey)
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
  // the agent's reply over /events. Customers who want token-streamed
  // replies can pass {tokenStream: true} to fall back to consuming the
  // SSE response from stream_message; not implemented in v0.1.
  async send(text: string): Promise<void> {
    const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentUuid}/agent_convos/${this.cfg.convoUuid}/stream_message`
    const jwt = await this.cfg.jwt.get()
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ text })
    })
    if (!res.ok) {
      const err = new Error(`stream_message failed: HTTP ${res.status}`)
      this.emit("error", { error: err, phase: "fetch" })
      throw err
    }
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

  // Open the SSE stream and run the reconnect loop until close().
  start(): void {
    this.leader.start({
      onBecameLeader:   () => this.runStreamLoop(),
      onForwardedEvent: (data) => this.emitForwarded(data)
    })
  }

  close(): void {
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
      const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentUuid}/agent_convos/${this.cfg.convoUuid}/events`
      let lastClose: ClosedEvent["reason"] | null = null
      let httpStatus: number | undefined
      let retryAfter: number | undefined

      try {
        const jwt = await this.cfg.jwt.get()
        await connectSse({
          url,
          headers: {
            "Authorization": `Bearer ${jwt}`,
            "Accept":        "text/event-stream"
          },
          signal:  this.aborter.signal,
          onOpen:  () => { /* opened — wait for `ready` frame */ },
          onEvent: (evt) => {
            const captured = this.handleEvent(evt)
            if (captured?.kind === "closed") lastClose = captured.reason
          },
          onError: (_err, status, ra) => {
            httpStatus = status
            retryAfter = ra
            if (status === 401) {
              // Caller refreshes JWT before next iteration.
              void this.cfg.jwt.refresh()
            }
          }
        })
      } catch {
        // connectSse re-throws onError to terminate; we handle below.
      }

      if (this.closed) break

      let decision
      if (httpStatus !== undefined) {
        decision = this.reconnect.decideOnError(httpStatus, retryAfter)
      } else {
        decision = this.reconnect.decideOnClose(lastClose)
      }
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
        if (!this.firstReady) {
          // Reconnect → fill the gap.
          void this.reconcileFetch()
        }
        this.firstReady = false
        return null
      case "message": {
        const m: Message = evt.message
        if (!this.dedupe.observe(m.uuid)) return null
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
      const url = `${this.cfg.baseUrl}/api/v2/agents/${this.cfg.agentUuid}/agent_convos/${this.cfg.convoUuid}`
      const jwt = await this.cfg.jwt.get()
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" }
      })
      if (!res.ok) return // best-effort
      const body = await res.json() as { messages?: Message[] }
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (this.dedupe.observe(m.uuid)) {
            // Synthesize a `message` event — same shape as a live broadcast.
            this.emit("message", {
              type: "message",
              action: "create",
              at: Date.now() / 1000,
              agent_uuid: this.cfg.agentUuid,
              convo_uuid: this.cfg.convoUuid,
              message: m
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
      try { h(data) } catch { /* swallow handler errors */ }
    }
  }
}

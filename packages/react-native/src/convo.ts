// React Native Convo — same state machine as the browser SDK's Convo,
// but with platform adapters for the things browsers handle for free:
//
//   - SSE transport: react-native-sse (native HTTP streaming on each
//     platform), wired through ./sse.ts
//   - Tab-leader election: NO-OP — RN apps are single-process; the
//     server-side cap of 2 absorbs reconnect overlap with no client help
//   - Visibility lifecycle: React Native's `AppState`, not
//     `document.visibilitychange`. Closes the SSE on background and
//     reopens on foreground to prevent zombie slots when the app is
//     suspended.

import type {
  AnyServerEvent,
  ClientEventMap,
  ClientEventName,
  ClosedEvent,
  Message,
  ReadyEvent
} from "@valet.red/sdk-core"
import { JwtStore } from "@valet.red/sdk-core"
import { MessageDedupe } from "@valet.red/sdk-core"
import { ReconnectPolicy, sleep } from "@valet.red/sdk-core"
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native"
import { connectSse } from "./sse"

const MAX_CONSECUTIVE_401S = 3

interface ConvoConfig {
  agentId: string
  convoId: string
  baseUrl: string
  jwt:     JwtStore
  debug?:  boolean
  // When true (default), the convo closes its SSE stream on AppState
  // 'background' / 'inactive' and reopens on 'active'. Eliminates the
  // zombie-slot problem when iOS / Android suspend the app.
  pauseOnBackground?: boolean
}

type Handler<E extends ClientEventName> = (data: ClientEventMap[E]) => void

export class Convo {
  private handlers: { [K in ClientEventName]?: Handler<K>[] } = {}
  private aborter: AbortController | null = null
  private closed = false
  private paused = false
  private firstReady = true
  private reconnect = new ReconnectPolicy()
  private dedupe = new MessageDedupe()
  private appStateSub: NativeEventSubscription | null = null
  private consecutive401s = 0

  constructor(private readonly cfg: ConvoConfig) {}

  private log(...args: unknown[]): void {
    if (this.cfg.debug) console.debug("[valet-sdk-rn]", `[${this.cfg.convoId.slice(0, 8)}]`, ...args)
  }

  on<E extends ClientEventName>(event: E, handler: Handler<E>): () => void {
    const list = (this.handlers[event] ??= []) as Handler<E>[]
    list.push(handler)
    return () => {
      const idx = list.indexOf(handler)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  async send(text: string, opts: { files?: { uri: string; name: string; type: string }[] } = {}): Promise<void> {
    let messageId: string | undefined
    const files = opts.files ?? []
    if (files.length > 0) {
      messageId = await this.uploadFiles(files)
    }

    const url = `${this.cfg.baseUrl}/api/v2/agent_convos/${this.cfg.convoId}/stream_message`
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
    if (res.status === 429) {
      // Rate-limited turn — see web/src/convo.ts for full rationale.
      const retryHeader  = res.headers.get("retry-after")
      const headerSecs   = retryHeader ? Number(retryHeader) : undefined
      const body         = await res.json().catch(() => ({} as any))
      const retrySeconds = (typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined) ?? headerSecs
      const err          = new Error(`rate_limited${retrySeconds ? `; retry in ${retrySeconds}s` : ""}`)
      ;(err as any).retryAfterSeconds = retrySeconds
      ;(err as any).status            = 429
      this.log("send RATE_LIMITED", { retrySeconds })
      this.emit("error", { error: err, phase: "fetch" })
      throw err
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      const err = new Error(`stream_message failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
      this.log("send FAILED", { status: res.status, body: txt })
      this.emit("error", { error: err, phase: "fetch" })
      throw err
    }
    this.log("send OK", { messageId })
  }

  // RN file uploads use `{uri, name, type}` instead of File objects.
  // FormData accepts the RN shape directly.
  async uploadFiles(files: { uri: string; name: string; type: string }[]): Promise<string> {
    const url = `${this.cfg.baseUrl}/api/v2/agent_convos/${this.cfg.convoId}/upload_file`
    this.log("uploadFiles →", { count: files.length })
    const jwt = await this.cfg.jwt.get()
    const fd = new FormData()
    for (const f of files) {
      // RN FormData accepts a {uri, name, type} object as a "file" value;
      // the filename is read from the object's `name` property — RN's
      // FormData.append signature is (name, value), no third filename arg.
      fd.append("files[]", f as unknown as Blob)
    }
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${jwt}` },
      // RN's RequestInit.body type is narrower than fd's TS type; cast to any.
      body:    fd as any
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

  start(): void {
    this.log("start")
    this.attachAppStateListener()
    this.runStreamLoop()
  }

  close(): void {
    this.log("close")
    this.closed = true
    this.aborter?.abort()
    this.aborter = null
    this.detachAppStateListener()
  }

  pause(): void {
    if (this.paused || this.closed) return
    this.log("pause")
    this.paused = true
    this.aborter?.abort()
    this.aborter = null
  }

  resume(): void {
    if (!this.paused || this.closed) return
    this.log("resume")
    this.paused = false
    this.runStreamLoop()
  }

  private attachAppStateListener(): void {
    if (this.cfg.pauseOnBackground === false) return
    this.appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") this.pause()
      else if (state === "active") this.resume()
    })
  }

  private detachAppStateListener(): void {
    if (this.appStateSub) {
      try { this.appStateSub.remove() } catch { /* noop */ }
      this.appStateSub = null
    }
  }

  async runStreamLoop(): Promise<void> {
    while (!this.closed && !this.paused) {
      this.aborter = new AbortController()
      const url = `${this.cfg.baseUrl}/api/v2/agent_convos/${this.cfg.convoId}/events`
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
            if (status === 401) void this.cfg.jwt.refresh()
          }
        })
      } catch (e) {
        this.log("SSE threw", e instanceof Error ? e.message : e)
      }

      if (this.closed || this.paused) break

      if (httpStatus === 401) {
        this.consecutive401s++
        if (this.consecutive401s >= MAX_CONSECUTIVE_401S) {
          this.log("401 circuit breaker tripped", { consecutive: this.consecutive401s })
          this.emit("error", {
            error: new Error(`auth failed ${this.consecutive401s}× in a row — check JWT signing`),
            phase: "auth"
          })
          break
        }
      } else {
        this.consecutive401s = 0
      }

      const decision = httpStatus !== undefined
        ? this.reconnect.decideOnError(httpStatus, retryAfter)
        : this.reconnect.decideOnClose(lastClose)
      this.log("reconnect decision", { httpStatus, lastClose, ...decision })
      if (!decision.shouldReconnect) {
        this.emit("error", { error: new Error("non-recoverable close"), phase: "stream" })
        break
      }
      if (decision.delayMs > 0) await sleep(decision.delayMs)
    }
  }

  handleEvent(evt: AnyServerEvent): { kind: "closed"; reason: ClosedEvent["reason"] } | null {
    switch (evt.type) {
      case "ready":
        this.reconnect.noteReady()
        this.consecutive401s = 0
        this.emit("ready", evt)
        void this.reconcileFetch()
        this.firstReady = false
        return null
      case "message": {
        const m: Message = evt.message
        if (!this.dedupe.observe(m.id)) return null
        this.emit("message", evt)
        return null
      }
      case "typing":
        this.emit("typing", evt)
        return null
      case "convo_state":
        this.emit("convo_state", evt)
        return null
      case "turn_done":
        this.emit("turn_done", evt)
        return null
      case "error":
        // Server-emitted SSE error frame. Forwarded to the same `error`
        // listener as SDK-internal errors; consumers disambiguate by the
        // presence of `reason` (server) vs `error` (SDK-internal).
        this.emit("error", evt)
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

  async reconcileFetch(): Promise<void> {
    try {
      const url = `${this.cfg.baseUrl}/api/v2/agent_convos/${this.cfg.convoId}`
      this.log("reconcileFetch →", url)
      const jwt = await this.cfg.jwt.get()
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" }
      })
      if (!res.ok) {
        this.log("reconcileFetch FAILED", { status: res.status })
        return
      }
      const body = await res.json() as { messages?: Message[] }
      this.log("reconcileFetch OK", { messages: body.messages?.length ?? 0 })
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (this.dedupe.observe(m.id)) {
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

  emit<E extends ClientEventName>(event: E, data: ClientEventMap[E]): void {
    const list = this.handlers[event] as Handler<E>[] | undefined
    if (!list) return
    for (const h of list) {
      try {
        h(data)
      } catch (e) {
        if (this.cfg.debug) console.debug("[valet-sdk-rn] handler threw for", event, e)
      }
    }
  }
}

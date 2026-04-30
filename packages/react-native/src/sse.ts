// SSE wire layer for React Native — wraps `react-native-sse`'s
// EventSource into the same shape the Convo loop expects.
//
// `react-native-sse` is a peer dependency. Apps install it themselves so
// we don't pin their RN version. Header injection (`Authorization: Bearer ...`)
// works because react-native-sse passes the `headers` option to the
// native HTTP client (URLSession on iOS, OkHttp on Android).
//
// Why not @microsoft/fetch-event-source: it depends on browser fetch's
// streaming `ReadableStream` body, which is unreliable in RN even on
// modern versions. react-native-sse uses native HTTP streaming on each
// platform.

import EventSource, { type MessageEvent } from "react-native-sse"
import type { AnyServerEvent, CloseReason } from "@valet.red/sdk-core"

export interface SseOpts {
  url:      string
  headers:  Record<string, string>
  signal:   AbortSignal
  onOpen:   () => void
  onEvent:  (evt: AnyServerEvent) => void
  onError:  (err: unknown, status?: number, retryAfter?: number) => void
}

export async function connectSse(opts: SseOpts): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let opened   = false
    let closing  = false
    let httpStatus: number | undefined
    let retryAfter: number | undefined

    // event types we listen for — the server's named events plus 'open'
    // and 'error' from the EventSource lifecycle. NB: react-native-sse
    // dispatches by literal `event:` line, so any new server event
    // name MUST be added here or it'll be silently dropped.
    const namedEvents = ["ready", "message", "typing", "convo_state", "turn_done", "error", "ping", "closed"] as const

    const es = new EventSource(opts.url, {
      headers:        opts.headers,
      // react-native-sse will reconnect on its own by default; we want
      // OUR reconnect logic (with the close-reason switch and backoff)
      // to drive that, so we disable the lib's internal retry
      pollingInterval: 0,
      // keep the connection alive longer than the default
      timeout:         3_600_000,
      timeoutBeforeConnection: 0
    })

    const onAbort = () => {
      closing = true
      try { es.close() } catch { /* noop */ }
      resolve()
    }
    if (opts.signal.aborted) { onAbort(); return }
    opts.signal.addEventListener("abort", onAbort)

    es.addEventListener("open", () => {
      opened = true
      opts.onOpen()
    })

    // react-native-sse v1+ delivers a union here (error / exception / timeout).
    // We only need the optional `xhrStatus` field; treat the event as `any`.
    es.addEventListener("error", (e: any) => {
      httpStatus = typeof e?.xhrStatus === "number" ? e.xhrStatus : (typeof e?.status === "number" ? e.status : undefined)
      retryAfter = undefined
      opts.onError(e, httpStatus, retryAfter)
      try { es.close() } catch { /* noop */ }
      if (!closing) {
        opts.signal.removeEventListener("abort", onAbort)
        resolve()
      }
    })

    namedEvents.forEach(name => {
      es.addEventListener(name as any, (e: MessageEvent) => {
        if (!e.data) return
        let payload: any
        try { payload = JSON.parse(e.data as string) } catch { return }
        if (payload && typeof payload === "object") {
          payload.type = name
          opts.onEvent(payload as AnyServerEvent)
          if (name === "closed") {
            // server-initiated close — let the loop record the reason and reconnect
            closing = true
            try { es.close() } catch { /* noop */ }
            opts.signal.removeEventListener("abort", onAbort)
            resolve()
          }
        }
      })
    })
  })
}

export type { CloseReason }

// SSE wire layer — fetch + ReadableStream-based, NOT browser EventSource.
//
// ─── Why not EventSource ─────────────────────────────────────────────
//
//   1. EventSource cannot send custom Authorization headers without
//      unsafe token-in-query workarounds (which would put the JWT in
//      every proxy log + browser history + APM trace).
//   2. EventSource auto-reconnects every 3s on any close, defeating
//      server-side caps and creating reconnect storms — the exact bug
//      that caused us to redesign in the first place.
//   3. EventSource has no AbortController-equivalent; clean shutdown
//      requires .close() which races with the auto-reconnect timer.
//   4. EventSource swallows HTTP status codes — every error surfaces
//      as a generic "error" event, so 401 vs 429 vs 5xx are
//      indistinguishable to the SDK reconnect logic.
//
// fetch + ReadableStream + AbortController gives us:
//   - Custom headers (Authorization: Bearer ...)
//   - Deterministic shutdown (abort() and the connection is gone)
//   - Real HTTP status codes (we read them in onopen)
//   - No magic auto-reconnect — caller (Convo) drives the reconnect loop
//
// ─── Why @microsoft/fetch-event-source ───────────────────────────────
//
// SSE wire parsing is fiddly: multi-line `data:`, comment frames
// (lines starting with `:`), Last-Event-ID, retry hints. Microsoft's
// library handles the parsing correctly. We import it as a primitive
// and wrap it with our typed event vocabulary. ~3KB gzipped on top of
// our own code — worth it for correctness.
//
// ─── Porting notes ───────────────────────────────────────────────────
//
//   * Python: requests + iter_lines, or httpx + AsyncStream. Same
//     parsing rules: split on \n\n, handle multi-line data, ignore
//     comment frames.
//   * Swift: URLSessionDataTask delegate + manual line buffering.
//   * Kotlin: OkHttp's EventSource (Server-Sent Events) feature.
//   * Go: bufio.Scanner over the response body.
//
// The wire format itself is the SSE spec — never invent a different
// format here even if a target language has a "nicer" RPC primitive.

import {
  fetchEventSource,
  type EventSourceMessage,
  type FetchEventSourceInit
} from "@microsoft/fetch-event-source"

import type { AnyServerEvent } from "@valet.red/sdk-core"

export interface SseStreamOptions {
  url: string
  headers: Record<string, string>
  onEvent: (event: AnyServerEvent) => void
  onOpen: () => void
  onError: (err: Error, status?: number, retryAfterSeconds?: number) => void
  signal: AbortSignal
}

// Connect once. Returns when the stream ends (server close, client
// abort, or fatal error). Caller drives reconnect.
export async function connectSse(opts: SseStreamOptions): Promise<void> {
  const init: FetchEventSourceInit = {
    method: "GET",
    headers: opts.headers,
    signal: opts.signal,
    openWhenHidden: true, // we want to keep streaming when tab is bg
    onopen: async (res) => {
      if (res.ok && (res.headers.get("content-type") || "").startsWith("text/event-stream")) {
        opts.onOpen()
        return
      }
      const ra = parseRetryAfter(res.headers.get("retry-after"))
      const err = new Error(`SSE open failed: ${res.status}`)
      ;(err as any).status = res.status
      opts.onError(err, res.status, ra)
      // Throw to terminate fetchEventSource; caller decides reconnect.
      throw err
    },
    onmessage: (msg: EventSourceMessage) => {
      if (msg.event && msg.data) {
        const evt = parseEvent(msg.event, msg.data)
        if (evt) opts.onEvent(evt)
      }
    },
    onclose: () => {
      // Server closed cleanly — return; loop ends.
    },
    onerror: (err: any) => {
      // Default behavior of fetch-event-source is to auto-retry; we
      // disable that by re-throwing. The library treats a thrown error
      // as "stop", and our caller (Convo) drives the reconnect loop.
      opts.onError(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  await fetchEventSource(opts.url, init)
}

function parseEvent(name: string, data: string): AnyServerEvent | null {
  try {
    const payload = JSON.parse(data) as Record<string, unknown>
    // Event name from SSE `event:` line is authoritative; we tag the
    // payload with `type` so downstream switch-by-type works whether
    // the server included a `type` field or not.
    if (!payload.type) {
      ;(payload as any).type = name
    }
    return payload as unknown as AnyServerEvent
  } catch {
    return null
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) ? seconds : undefined
}

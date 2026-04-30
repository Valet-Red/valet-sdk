// Reconnect protocol — translates server close-reasons into client
// behavior:
//   server_cap / shutdown / auth_expiring → reconnect immediately
//   stalled / network / parse error / 5xx → exponential backoff
//   429                                   → respect Retry-After
//
// ─── Design decisions ────────────────────────────────────────────────
//
// 1. Backoff schedule 250ms → 30s, factor 2. Cribbed from common SDK
//    patterns (Stripe, Anthropic, AWS). Why these specific numbers:
//    - 250ms initial: short enough to feel instant on a transient blip,
//      long enough to not hammer the server during a real outage.
//    - 30s max cap: matches the longest reasonable Retry-After we'd
//      respect from a 429; aligns idle-tab reconnect cadence with the
//      server's 1-hour wall-clock cap.
//    - factor 2: standard. Could be 1.5 for more aggressive retry, or
//      2.5 for less. 2 is the "no surprise" default.
//
// 2. Reset on `event: ready`, NOT on first byte received. The server
//    emits `ready` immediately on a clean open; receiving it confirms
//    the full handshake (TLS + TCP + JWT verify + convo ownership +
//    cap acquired) succeeded. Reset earlier than that and a
//    half-open-then-fail loop wouldn't apply backoff.
//
// 3. Close-reason switch: server-graceful closes (server_cap, shutdown,
//    auth_expiring) reconnect IMMEDIATELY because the server told us
//    "I'm cutting you for a known reason, not because anything's
//    broken." Backing off in those cases would unnecessarily delay
//    reconnection and worsen the user experience.
//
// 4. 4xx other than 408/429: stop. These are unrecoverable
//    misconfiguration (bad agent_uuid, malformed request, no permission).
//    Backing off would just spin forever. Surface to caller as an error.
//
// 5. 401 reconnects with delay 0 once. Caller is expected to refresh
//    the JWT before retry. If a second 401 happens, the policy returns
//    delay 0 again BUT the caller is responsible for breaking the loop
//    after N consecutive 401s — this module doesn't track auth state.
//
// ─── Porting notes ───────────────────────────────────────────────────
//
//   The schedule + decision matrix above is the contract. JS gets
//   sleep() via setTimeout; other languages substitute their idiom
//   (asyncio.sleep, Thread.sleep, DispatchQueue, etc.).

import type { CloseReason } from "./types"

const INITIAL_DELAY_MS = 250
const MAX_DELAY_MS     = 30000
const FACTOR           = 2

export interface ReconnectDecision {
  shouldReconnect: boolean
  delayMs: number
}

export class ReconnectPolicy {
  private currentDelay: number

  constructor() {
    this.currentDelay = INITIAL_DELAY_MS
  }

  // Reset on a successful `event: ready` — the next failure starts
  // backoff from INITIAL_DELAY again.
  noteReady(): void {
    this.currentDelay = INITIAL_DELAY_MS
  }

  // Server-initiated graceful close — typically reconnect immediately.
  decideOnClose(reason: CloseReason | null): ReconnectDecision {
    switch (reason) {
      case "server_cap":
      case "shutdown":
      case "auth_expiring":
        return { shouldReconnect: true, delayMs: 0 }
      case "stalled":
        return { shouldReconnect: true, delayMs: this.bumpDelay() }
      default:
        // Unknown / no close frame at all (network drop) — backoff.
        return { shouldReconnect: true, delayMs: this.bumpDelay() }
    }
  }

  // Network-layer or HTTP-error reconnects.
  decideOnError(status?: number, retryAfterSeconds?: number): ReconnectDecision {
    if (status === 429) {
      const ra = retryAfterSeconds ?? 30
      // Cap at MAX_DELAY_MS to be safe even if server returns absurd Retry-After.
      const delayMs = Math.min(ra * 1000, MAX_DELAY_MS)
      return { shouldReconnect: true, delayMs }
    }
    if (status === 401) {
      // Auth — caller refreshes JWT; reconnect immediately. If we 401
      // again on retry, caller surfaces the error.
      return { shouldReconnect: true, delayMs: 0 }
    }
    if (status && status >= 400 && status < 500 && status !== 408) {
      // 4xx other than 408 — usually unrecoverable. Stop.
      return { shouldReconnect: false, delayMs: 0 }
    }
    // 5xx, network drop, parse error — backoff.
    return { shouldReconnect: true, delayMs: this.bumpDelay() }
  }

  // For tests.
  peekDelay(): number { return this.currentDelay }

  bumpDelay(): number {
    const d = this.currentDelay
    this.currentDelay = Math.min(this.currentDelay * FACTOR, MAX_DELAY_MS)
    return d
  }
}

// Helper for sleeping that's mockable in tests via setTimeout.
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

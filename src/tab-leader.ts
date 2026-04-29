// Tab-leader election via BroadcastChannel. When multiple tabs of the
// customer's app open the SDK for the same (appuser, agent), only the
// LEADER tab opens the SSE connection; followers receive forwarded
// events through the BroadcastChannel.
//
// ─── Why this exists ─────────────────────────────────────────────────
//
// Server-side cap is 2 SSE connections per (appuser, agent). With the
// cap of 2, normal reconnect-overlap (close → reopen race) sits under
// the cap and works fine. But two open tabs is one over the cap; three
// tabs guarantees a 429. So a customer whose end-user just happens to
// open the chat in a second tab gets a degraded experience unless the
// SDK coordinates.
//
// ─── Design decisions ────────────────────────────────────────────────
//
// 1. BroadcastChannel over SharedWorker. SharedWorker has better
//    leader semantics out of the box (one worker process, many tabs)
//    but is poorly supported in Safari and breaks in some embedded
//    webviews. BroadcastChannel is universally supported in modern
//    browsers; we DIY the leader election on top.
//
// 2. Heartbeat interval = 1s, timeout = 3s. Three missed heartbeats
//    triggers election. Smaller intervals catch leader-tab-closed
//    faster but burn more CPU; 1s/3s is a reasonable balance.
//
// 3. Tie-break on duplicate leadership: lower tabId wins. Random
//    string IDs generated locally. Two tabs simultaneously becoming
//    leader is rare (jitter helps); when it happens, the lower-ID tab
//    keeps leadership and the other steps down.
//
// 4. Followers receive forwarded events via the same BroadcastChannel
//    (different message type). Latency is ~milliseconds — same-process
//    postMessage. Acceptable for chat UX.
//
// 5. Channel name includes (agentId, convoId) so distinct convos
//    don't share leader state. A user with two different agents in two
//    tabs gets two independent leader elections.
//
// 6. Fallback when BroadcastChannel is undefined: become leader
//    immediately. Better to have one tab work than zero. Means the
//    cap-of-2 problem reappears in those environments — but those
//    environments are rare and largely outside our control.
//
// ─── Porting notes ───────────────────────────────────────────────────
//
//   Web SDKs (other JS frameworks): BroadcastChannel is the right
//   primitive everywhere modern.
//
//   Native SDKs (iOS / Android / desktop) typically have ONE app
//   process so this whole module collapses to "always leader." Skip
//   the election entirely.
//
//   Server-side / Node SDKs: also "always leader" (no multi-tab).

const CHANNEL_PREFIX        = "valet-events:"
const HEARTBEAT_INTERVAL_MS = 1_000
const HEARTBEAT_TIMEOUT_MS  = 3_000
// First election runs much faster than re-election. On initial start
// we only need to listen long enough to catch one heartbeat from a
// pre-existing leader (heartbeats fire every 1s) — 300ms with jitter
// is plenty when no leader is alive, while still detecting one if it
// is. Re-elections (after a previously-seen leader goes silent) still
// use the full HEARTBEAT_TIMEOUT_MS to avoid flapping leadership on
// transient hiccups.
const INITIAL_ELECTION_MS   = 300

interface LeaderMessage {
  type: "heartbeat" | "event" | "claim_leader"
  tabId: string
  payload?: unknown
}

export class TabLeader {
  private channel: BroadcastChannel | null = null
  private tabId = randomId()
  private isLeader = false
  private lastSeenLeaderAt = 0
  private hasSeenLeader = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private electionTimer: ReturnType<typeof setTimeout> | null = null
  private onBecameLeader: (() => void) | null = null
  private onForwardedEvent: ((data: unknown) => void) | null = null

  constructor(private readonly key: string) {}

  start(opts: {
    onBecameLeader: () => void
    onForwardedEvent: (data: unknown) => void
  }): void {
    this.onBecameLeader = opts.onBecameLeader
    this.onForwardedEvent = opts.onForwardedEvent
    if (typeof BroadcastChannel === "undefined") {
      // No multi-tab coordination available (some embedded webviews).
      // Just become leader immediately.
      this.becomeLeader()
      return
    }
    this.channel = new BroadcastChannel(CHANNEL_PREFIX + this.key)
    this.channel.onmessage = (e: MessageEvent<LeaderMessage>) => this.handleMessage(e.data)
    // Wait briefly for an existing leader's heartbeat. If none, elect.
    this.scheduleElection()
  }

  // Leader broadcasts an SSE-derived event to followers.
  forwardEvent(payload: unknown): void {
    if (!this.isLeader || !this.channel) return
    this.channel.postMessage({ type: "event", tabId: this.tabId, payload } satisfies LeaderMessage)
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.electionTimer) clearTimeout(this.electionTimer)
    if (this.channel) {
      try { this.channel.close() } catch { /* noop */ }
    }
    this.heartbeatTimer = null
    this.electionTimer = null
    this.channel = null
    this.isLeader = false
  }

  // For tests.
  amLeader(): boolean { return this.isLeader }

  handleMessage(msg: LeaderMessage): void {
    if (msg.tabId === this.tabId) return
    switch (msg.type) {
      case "heartbeat":
        this.lastSeenLeaderAt = Date.now()
        this.hasSeenLeader = true
        if (this.isLeader) {
          // Two leaders is a split-brain. Lower tabId wins.
          if (msg.tabId < this.tabId) this.stepDown()
        } else {
          this.scheduleElection()
        }
        break
      case "event":
        if (!this.isLeader && this.onForwardedEvent) {
          this.onForwardedEvent(msg.payload)
        }
        break
      case "claim_leader":
        if (this.isLeader && msg.tabId < this.tabId) this.stepDown()
        break
    }
  }

  scheduleElection(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer)
    const jitter = Math.random() * 100
    // Fast path on initial start (no leader has ever been seen on this
    // channel): wait just long enough to catch one heartbeat from an
    // existing leader. After we've seen a leader at least once, fall
    // back to the conservative 3s window.
    const wait = (this.hasSeenLeader ? HEARTBEAT_TIMEOUT_MS : INITIAL_ELECTION_MS) + jitter
    const threshold = this.hasSeenLeader ? HEARTBEAT_TIMEOUT_MS : INITIAL_ELECTION_MS
    this.electionTimer = setTimeout(() => {
      const sinceLastSeen = Date.now() - this.lastSeenLeaderAt
      if (sinceLastSeen > threshold) {
        this.becomeLeader()
      }
    }, wait)
  }

  becomeLeader(): void {
    if (this.isLeader) return
    this.isLeader = true
    if (this.channel) {
      this.channel.postMessage({ type: "claim_leader", tabId: this.tabId } satisfies LeaderMessage)
    }
    if (this.onBecameLeader) this.onBecameLeader()
    this.heartbeatTimer = setInterval(() => {
      if (!this.channel) return
      this.channel.postMessage({ type: "heartbeat", tabId: this.tabId } satisfies LeaderMessage)
    }, HEARTBEAT_INTERVAL_MS)
  }

  stepDown(): void {
    if (!this.isLeader) return
    this.isLeader = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.scheduleElection()
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Bounded message-UUID dedupe set. Used by Convo to merge events
// across the SSE stream and the post-`ready` reconcile fetch without
// re-rendering bubbles for messages we already saw.
//
// ─── Why this exists ─────────────────────────────────────────────────
//
// Server contract is "best-effort delivery + reconcile via fetch."
// Between-turn events that fire during a network drop are lost; the
// SDK reconciles via the GET /agent_convos/{uuid} endpoint after each
// reconnect. That fetch returns the FULL message history — but most
// of those messages are ones we already saw. We dedupe by message UUID
// to avoid re-rendering them.
//
// ─── Design decisions ────────────────────────────────────────────────
//
// 1. Bounded at 5000 (not unbounded). A chat that runs for years
//    shouldn't accumulate unbounded memory just to track UUIDs we've
//    already discarded. 5000 is well above any realistic single-session
//    chat depth (a busy 24h support session might hit a few hundred
//    messages); LRU-evict the oldest when we exceed it.
//
// 2. LRU by insertion order, not access. Old messages that get
//    re-fetched in a reconcile DON'T touch their position in the
//    dedupe — they're still old. The window is "messages received in
//    this session, in chronological order" — the oldest evict first.
//
// 3. Empty-string UUIDs are passed through (returns true). Defensive
//    against server bugs that omit a UUID; better to render than to
//    silently drop.
//
// ─── Porting notes ───────────────────────────────────────────────────
//
//   Same shape in any language: a bounded ordered set keyed by UUID.
//   Python: collections.OrderedDict with maxlen behavior.
//   Swift: NSCache or a manual LinkedHashSet equivalent.
//   Java/Kotlin: LinkedHashMap with removeEldestEntry override.

const MAX = 5000

export class MessageDedupe {
  private set: Set<string>
  private order: string[]

  constructor() {
    this.set = new Set<string>()
    this.order = []
  }

  // Returns true if this is the first time we've seen this UUID.
  // Returns false if it's a duplicate.
  observe(uuid: string): boolean {
    if (!uuid) return true
    if (this.set.has(uuid)) return false
    this.set.add(uuid)
    this.order.push(uuid)
    if (this.order.length > MAX) {
      const evict = this.order.shift()
      if (evict) this.set.delete(evict)
    }
    return true
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }

  size(): number {
    return this.set.size
  }

  clear(): void {
    this.set.clear()
    this.order = []
  }
}

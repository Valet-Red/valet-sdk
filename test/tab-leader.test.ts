// Tab-leader election tests.
//
// happy-dom's BroadcastChannel does NOT actually broadcast across
// instances within the same JS context (verified empirically — sending
// from instance A does not deliver to instance B). Real browsers do.
// We install a small in-memory mock that emulates real cross-tab
// behavior so the leader-coordination logic is meaningfully tested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// In-memory broadcast bus, keyed by channel name.
const buses = new Map<string, Set<MockBroadcastChannel>>()

class MockBroadcastChannel {
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(public name: string) {
    let bus = buses.get(name)
    if (!bus) { bus = new Set(); buses.set(name, bus) }
    bus.add(this)
  }
  postMessage(data: unknown): void {
    const bus = buses.get(this.name)
    if (!bus) return
    // Synchronous delivery in tests — vitest fake timers don't drive
    // microtasks reliably, and we want heartbeats to be observable
    // when we advanceTimersByTime past their interval. Real
    // BroadcastChannel is async but the LOGIC under test
    // (heartbeat received → don't elect) doesn't depend on async-ness.
    for (const ch of bus) {
      if (ch === this) continue
      ch.onmessage?.({ data })
    }
  }
  close(): void {
    buses.get(this.name)?.delete(this)
  }
}

beforeEach(() => {
  buses.clear()
  ;(globalThis as any).BroadcastChannel = MockBroadcastChannel
})

import { TabLeader } from "../src/tab-leader"

describe("TabLeader", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("the first tab becomes leader after the election timeout", async () => {
    const t = new TabLeader("test-key-1")
    const onBecameLeader = vi.fn()
    t.start({ onBecameLeader, onForwardedEvent: () => {} })

    // Advance past the heartbeat timeout + jitter
    vi.advanceTimersByTime(3500)

    expect(t.amLeader()).toBe(true)
    expect(onBecameLeader).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it("second tab does NOT become leader while first is heartbeating", async () => {
    const t1 = new TabLeader("test-key-2")
    const t2 = new TabLeader("test-key-2")

    const onBecameLeader1 = vi.fn()
    const onBecameLeader2 = vi.fn()

    t1.start({ onBecameLeader: onBecameLeader1, onForwardedEvent: () => {} })
    vi.advanceTimersByTime(3500) // t1 elects
    expect(t1.amLeader()).toBe(true)

    t2.start({ onBecameLeader: onBecameLeader2, onForwardedEvent: () => {} })
    // Advance time but t1 is still heartbeating, so t2 should NOT elect
    vi.advanceTimersByTime(5000)
    expect(t2.amLeader()).toBe(false)
    expect(onBecameLeader2).not.toHaveBeenCalled()

    t1.stop()
    t2.stop()
  })

  it("forwards events from leader to follower via BroadcastChannel", async () => {
    const t1 = new TabLeader("test-key-3")
    const t2 = new TabLeader("test-key-3")
    const forwarded: unknown[] = []

    t1.start({ onBecameLeader: () => {}, onForwardedEvent: () => {} })
    vi.advanceTimersByTime(3500)
    t2.start({ onBecameLeader: () => {}, onForwardedEvent: (data) => forwarded.push(data) })
    vi.advanceTimersByTime(100)

    // Leader broadcasts; follower receives.
    t1.forwardEvent({ type: "message", uuid: "abc" })
    // BroadcastChannel postMessage is async-microtask in happy-dom
    await Promise.resolve()
    await Promise.resolve()

    expect(forwarded).toEqual([{ type: "message", uuid: "abc" }])
    t1.stop()
    t2.stop()
  })

  it("when BroadcastChannel is unavailable, becomes leader immediately", () => {
    const original = (globalThis as any).BroadcastChannel
    ;(globalThis as any).BroadcastChannel = undefined
    try {
      const t = new TabLeader("test-key-4")
      const onBecameLeader = vi.fn()
      t.start({ onBecameLeader, onForwardedEvent: () => {} })
      // No timer advance — should be leader immediately.
      expect(t.amLeader()).toBe(true)
      expect(onBecameLeader).toHaveBeenCalledTimes(1)
      t.stop()
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })
})

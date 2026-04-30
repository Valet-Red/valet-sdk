// Unit tests for ReconnectPolicy — the close-reason switch + backoff.

import { describe, expect, it } from "vitest"
import { ReconnectPolicy } from "@valet.red/sdk-core"

describe("ReconnectPolicy", () => {
  describe("close-reason switch", () => {
    it("server_cap → reconnect immediately (delay 0)", () => {
      const p = new ReconnectPolicy()
      expect(p.decideOnClose("server_cap")).toEqual({ shouldReconnect: true, delayMs: 0 })
    })

    it("shutdown → reconnect immediately", () => {
      const p = new ReconnectPolicy()
      expect(p.decideOnClose("shutdown")).toEqual({ shouldReconnect: true, delayMs: 0 })
    })

    it("auth_expiring → reconnect immediately", () => {
      const p = new ReconnectPolicy()
      expect(p.decideOnClose("auth_expiring")).toEqual({ shouldReconnect: true, delayMs: 0 })
    })

    it("stalled → reconnect with backoff", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnClose("stalled")
      expect(decision.shouldReconnect).toBe(true)
      expect(decision.delayMs).toBe(250) // initial
    })

    it("null close (network drop, no close frame) → backoff", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnClose(null)
      expect(decision.delayMs).toBe(250)
    })
  })

  describe("backoff schedule", () => {
    it("doubles on each consecutive backoff: 250 → 500 → 1000 → 2000 → ...", () => {
      const p = new ReconnectPolicy()
      const delays: number[] = []
      for (let i = 0; i < 5; i++) {
        delays.push(p.decideOnClose("stalled").delayMs)
      }
      expect(delays).toEqual([250, 500, 1000, 2000, 4000])
    })

    it("caps at 30 seconds", () => {
      const p = new ReconnectPolicy()
      // Burn through enough iterations to exceed 30s
      for (let i = 0; i < 20; i++) p.decideOnClose("stalled")
      expect(p.peekDelay()).toBe(30_000)
    })

    it("resets to 250ms on noteReady()", () => {
      const p = new ReconnectPolicy()
      p.decideOnClose("stalled")
      p.decideOnClose("stalled")
      p.decideOnClose("stalled")
      expect(p.peekDelay()).toBe(2000)
      p.noteReady()
      expect(p.peekDelay()).toBe(250)
    })
  })

  describe("HTTP error handling", () => {
    it("429 with Retry-After respects the header value", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnError(429, 30)
      expect(decision.shouldReconnect).toBe(true)
      expect(decision.delayMs).toBe(30_000)
    })

    it("429 without Retry-After defaults to 30s", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnError(429)
      expect(decision.delayMs).toBe(30_000)
    })

    it("429 with absurd Retry-After is clamped to 30s", () => {
      const p = new ReconnectPolicy()
      // Server returning Retry-After: 600 must not put the client to sleep
      // for 10 minutes — clamp to MAX_DELAY_MS.
      const decision = p.decideOnError(429, 600)
      expect(decision.delayMs).toBe(30_000)
    })

    it("429 with small Retry-After respects the smaller value", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnError(429, 5)
      expect(decision.delayMs).toBe(5_000)
    })

    it("401 → reconnect immediately (caller refreshes JWT)", () => {
      const p = new ReconnectPolicy()
      expect(p.decideOnError(401)).toEqual({ shouldReconnect: true, delayMs: 0 })
    })

    it("4xx (other than 408/429) → stop", () => {
      const p = new ReconnectPolicy()
      expect(p.decideOnError(404).shouldReconnect).toBe(false)
      expect(p.decideOnError(403).shouldReconnect).toBe(false)
      expect(p.decideOnError(400).shouldReconnect).toBe(false)
    })

    it("5xx → backoff", () => {
      const p = new ReconnectPolicy()
      const decision = p.decideOnError(500)
      expect(decision.shouldReconnect).toBe(true)
      expect(decision.delayMs).toBe(250)
    })
  })
})

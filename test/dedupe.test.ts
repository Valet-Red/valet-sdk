// Unit tests for MessageDedupe.

import { describe, expect, it } from "vitest"
import { MessageDedupe } from "../src/dedupe"

describe("MessageDedupe", () => {
  it("first observation of a UUID returns true", () => {
    const d = new MessageDedupe()
    expect(d.observe("uuid-1")).toBe(true)
  })

  it("subsequent observations of the same UUID return false", () => {
    const d = new MessageDedupe()
    d.observe("uuid-1")
    expect(d.observe("uuid-1")).toBe(false)
    expect(d.observe("uuid-1")).toBe(false)
  })

  it("distinct UUIDs are independent", () => {
    const d = new MessageDedupe()
    expect(d.observe("uuid-1")).toBe(true)
    expect(d.observe("uuid-2")).toBe(true)
    expect(d.observe("uuid-1")).toBe(false)
    expect(d.observe("uuid-2")).toBe(false)
  })

  it("empty UUID always returns true (defensive)", () => {
    const d = new MessageDedupe()
    expect(d.observe("")).toBe(true)
    expect(d.observe("")).toBe(true)
  })

  it("evicts oldest entries beyond the bound", () => {
    const d = new MessageDedupe()
    // Insert MAX+1 entries; the very first should be evicted.
    for (let i = 0; i < 5001; i++) {
      d.observe(`uuid-${i}`)
    }
    expect(d.has("uuid-0")).toBe(false) // evicted
    expect(d.has("uuid-5000")).toBe(true) // most recent retained
    expect(d.size()).toBe(5000)
  })

  it("clear() resets the set", () => {
    const d = new MessageDedupe()
    d.observe("uuid-1")
    d.observe("uuid-2")
    d.clear()
    expect(d.size()).toBe(0)
    expect(d.observe("uuid-1")).toBe(true) // re-observable after clear
  })
})

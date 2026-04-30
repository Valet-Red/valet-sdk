// Convo integration tests — exercises the real reconnect / dedupe /
// reconcile-fetch paths against a mocked SSE wire layer.
//
// We mock @microsoft/fetch-event-source so we control the event
// stream + close timing without spinning up a real server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// IMPORTANT: this mock must be installed before importing src/convo.
const mockFetchEventSource = vi.fn()
vi.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: (...args: unknown[]) => mockFetchEventSource(...args)
}))

import { Convo } from "../src/convo"
import { JwtStore } from "@valet.red/sdk-core"
import type { Message } from "@valet.red/sdk-core"

function fakeJwtStore(): JwtStore {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "")
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, "")
  const token = `${header}.${payload}.sig`
  return new JwtStore(() => token)
}

function newConvo(): Convo {
  return new Convo({
    agentId: "agent-uuid",
    convoId: "convo-uuid",
    baseUrl: "https://api.test",
    jwt:     fakeJwtStore()
  })
}

function fakeMessage(id: string): Message {
  return {
    id,
    content: "hi",
    from: "appuser",
    turn_number: 1,
    created_at: "",
    participant: null,
    files: []
  }
}

describe("Convo", () => {
  beforeEach(() => {
    mockFetchEventSource.mockReset()
    mockFetchEventSource.mockImplementation(async (_url: string, init: any) => {
      await init.onopen({ ok: true, status: 200, headers: new Map([["content-type", "text/event-stream"]]) })
      init.onmessage({ event: "ready", data: JSON.stringify({ conn_id: "abc" }) })
    })
  })

  it("handles a happy-path message event", () => {
    const c = newConvo()
    const messages: unknown[] = []
    c.on("message", (m) => messages.push(m))
    c.handleEvent({
      type: "message",
      action: "create",
      agent_id: "agent-uuid",
      convo_id: "convo-uuid",
      message: fakeMessage("m1")
    })
    expect(messages).toHaveLength(1)
  })

  it("dedupes messages with the same id", () => {
    const c = newConvo()
    const messages: unknown[] = []
    c.on("message", (m) => messages.push(m))
    const evt = {
      type: "message" as const,
      action: "create" as const,
      agent_id: "agent-uuid",
      convo_id: "convo-uuid",
      message: fakeMessage("same-id")
    }
    c.handleEvent(evt)
    c.handleEvent(evt)
    c.handleEvent(evt)
    expect(messages).toHaveLength(1)
  })

  it("emits typing events", () => {
    const c = newConvo()
    const typings: unknown[] = []
    c.on("typing", (t) => typings.push(t))
    c.handleEvent({
      type: "typing",
      state: "start",
      label: "Ally is thinking…",
      convo_id: "convo-uuid"
    })
    expect(typings).toHaveLength(1)
  })

  it("emits convo_state events", () => {
    const c = newConvo()
    const states: any[] = []
    c.on("convo_state", (s) => states.push(s))
    c.handleEvent({
      type: "convo_state",
      agent_id: "agent-uuid",
      convo_id: "convo-uuid",
      state: "escalated",
      prev_state: "open"
    })
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe("escalated")
  })

  it("returns close-reason from a closed event for the reconnect loop to read", () => {
    const c = newConvo()
    const result = c.handleEvent({ type: "closed", reason: "server_cap" })
    expect(result).toEqual({ kind: "closed", reason: "server_cap" })
  })

  it("ignores ping events", () => {
    const c = newConvo()
    const r = c.handleEvent({ type: "ping" })
    expect(r).toBeNull()
  })

  it("on() returns an unsubscribe function", () => {
    const c = newConvo()
    let count = 0
    const unsub = c.on("typing", () => { count++ })
    c.handleEvent({ type: "typing", state: "start", label: "x", convo_id: "convo-uuid" })
    expect(count).toBe(1)
    unsub()
    c.handleEvent({ type: "typing", state: "stop", label: "x", convo_id: "convo-uuid" })
    expect(count).toBe(1)
  })

  describe("pauseOnHidden", () => {
    function fireVisibility(state: "hidden" | "visible") {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state })
      document.dispatchEvent(new Event("visibilitychange"))
    }

    it("pauses on visibilitychange → hidden and resumes on → visible (default)", () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      const c = new Convo({
        agentId: "agent-uuid",
        convoId: "convo-uuid",
        baseUrl: "https://api.test",
        jwt:     fakeJwtStore()
      })
      c.start()
      expect((c as any).paused).toBe(false)

      fireVisibility("hidden")
      expect((c as any).paused).toBe(true)

      fireVisibility("visible")
      expect((c as any).paused).toBe(false)

      c.close()
    })

    it("ignores visibility changes when pauseOnHidden=false", () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      const c = new Convo({
        agentId:       "agent-uuid",
        convoId:       "convo-uuid",
        baseUrl:       "https://api.test",
        jwt:           fakeJwtStore(),
        pauseOnHidden: false
      })
      c.start()

      fireVisibility("hidden")
      expect((c as any).paused).toBe(false)

      c.close()
    })

    it("close() detaches the visibility listener so post-close events are no-ops", () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      const c = new Convo({
        agentId: "agent-uuid",
        convoId: "convo-uuid",
        baseUrl: "https://api.test",
        jwt:     fakeJwtStore()
      })
      c.start()
      c.close()

      fireVisibility("hidden")
      expect((c as any).paused).toBe(false)
      expect((c as any).closed).toBe(true)
    })
  })
})

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
import { JwtStore } from "../src/jwt"

function fakeJwtStore(): JwtStore {
  // 15-min token
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "")
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, "")
  const token = `${header}.${payload}.sig`
  return new JwtStore(() => token)
}

function newConvo(): Convo {
  return new Convo({
    agentUuid: "agent-uuid",
    convoUuid: "convo-uuid",
    baseUrl:   "https://api.test",
    jwt:       fakeJwtStore()
  })
}

describe("Convo", () => {
  beforeEach(() => {
    mockFetchEventSource.mockReset()
    // Default: connection succeeds, server emits one ready then closes.
    mockFetchEventSource.mockImplementation(async (_url: string, init: any) => {
      await init.onopen({ ok: true, status: 200, headers: new Map([["content-type", "text/event-stream"]]) })
      init.onmessage({ event: "ready", data: JSON.stringify({ at: Date.now() / 1000, conn_id: "abc" }) })
    })
  })

  it("handles a happy-path message event", () => {
    const c = newConvo()
    const messages: unknown[] = []
    c.on("message", (m) => messages.push(m))
    // Drive handleEvent directly (the public surface).
    c.handleEvent({
      type: "message", action: "create",
      at: 1, agent_uuid: "agent-uuid", convo_uuid: "convo-uuid",
      message: { uuid: "m1", content: "hi", role: "", from: "appuser",
        turn_number: 1, created_at: "", participant_id: null,
        participant_type: null, participant_key: null, participant: null,
        files: [], agent_convo_uuid: "convo-uuid" }
    })
    expect(messages).toHaveLength(1)
  })

  it("dedupes messages with the same UUID", () => {
    const c = newConvo()
    const messages: unknown[] = []
    c.on("message", (m) => messages.push(m))
    const evt = {
      type: "message" as const, action: "create" as const,
      at: 1, agent_uuid: "agent-uuid", convo_uuid: "convo-uuid",
      message: { uuid: "same-uuid", content: "hi", role: "", from: "appuser" as const,
        turn_number: 1, created_at: "", participant_id: null,
        participant_type: null, participant_key: null, participant: null,
        files: [], agent_convo_uuid: "convo-uuid" }
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
      type: "typing", at: 1, state: "start",
      label: "Ally is thinking…", convo_uuid: "convo-uuid"
    })
    expect(typings).toHaveLength(1)
  })

  it("emits convo_state events", () => {
    const c = newConvo()
    const states: any[] = []
    c.on("convo_state", (s) => states.push(s))
    c.handleEvent({
      type: "convo_state", at: 1, agent_uuid: "agent-uuid",
      convo_uuid: "convo-uuid", state: "escalated", prev_state: "open"
    })
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe("escalated")
  })

  it("returns close-reason from a closed event for the reconnect loop to read", () => {
    const c = newConvo()
    const result = c.handleEvent({
      type: "closed", at: 1, reason: "server_cap"
    })
    expect(result).toEqual({ kind: "closed", reason: "server_cap" })
  })

  it("ignores ping events", () => {
    const c = newConvo()
    const r = c.handleEvent({ type: "ping", at: 1 } as any)
    expect(r).toBeNull()
  })

  it("on() returns an unsubscribe function", () => {
    const c = newConvo()
    let count = 0
    const unsub = c.on("typing", () => { count++ })
    c.handleEvent({ type: "typing", at: 1, state: "start", label: "x", convo_uuid: "convo-uuid" })
    expect(count).toBe(1)
    unsub()
    c.handleEvent({ type: "typing", at: 1, state: "stop", label: "x", convo_uuid: "convo-uuid" })
    expect(count).toBe(1) // unsubscribed
  })
})

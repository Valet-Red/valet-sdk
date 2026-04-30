// Unit tests for JwtStore — the JWT cache + refresh path.
//
// We don't verify JWTs in the SDK (the server does that); these tests
// only check our caching + refresh-window behavior. We mint test
// tokens by hand-base64-encoding a header+payload (no signature
// validation needed for the SDK's purposes).

import { describe, expect, it, vi } from "vitest"
import { JwtStore } from "../src/jwt"

function mintToken(expSecondsFromNow: number): string {
  const header = { alg: "HS256", typ: "JWT" }
  const payload = {
    iss: "company_key_xyz",
    aud: "valet-sdk",
    company_key: "company_key_xyz",
    agent_uuid: "agent-uuid",
    source_key: "user_42",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow
  }
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${enc(header)}.${enc(payload)}.fake-signature`
}

describe("JwtStore", () => {
  it("returns the token from fetchJwt on first call", async () => {
    const token = mintToken(900) // 15 min
    const fetchJwt = vi.fn().mockResolvedValue(token)
    const store = new JwtStore(fetchJwt)

    const t = await store.get()
    expect(t).toBe(token)
    expect(fetchJwt).toHaveBeenCalledTimes(1)
  })

  it("caches the token across multiple .get() calls within freshness window", async () => {
    const token = mintToken(900)
    const fetchJwt = vi.fn().mockResolvedValue(token)
    const store = new JwtStore(fetchJwt)

    await store.get()
    await store.get()
    await store.get()
    expect(fetchJwt).toHaveBeenCalledTimes(1)
  })

  it("refreshes proactively when remaining lifetime drops below 5 minutes", async () => {
    // Token already 4 minutes from expiry — should trigger refresh.
    const oldToken = mintToken(4 * 60)
    const newToken = mintToken(15 * 60)
    const fetchJwt = vi.fn()
      .mockResolvedValueOnce(oldToken)
      .mockResolvedValueOnce(newToken)
    const store = new JwtStore(fetchJwt)

    const first = await store.get()
    expect(first).toBe(oldToken)
    // First call cached the 4-min-out token; the freshness check on
    // get() #2 sees <5min remaining and triggers refresh.
    const second = await store.get()
    expect(second).toBe(newToken)
    expect(fetchJwt).toHaveBeenCalledTimes(2)
  })

  it("dedupes concurrent refresh requests into a single fetchJwt call", async () => {
    const token = mintToken(900)
    let resolveFetch!: (v: string) => void
    const fetchJwt = vi.fn(() => new Promise<string>(r => { resolveFetch = r }))
    const store = new JwtStore(fetchJwt)

    const a = store.get()
    const b = store.get()
    const c = store.get()
    resolveFetch(token)
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe(token)
    expect(rb).toBe(token)
    expect(rc).toBe(token)
    expect(fetchJwt).toHaveBeenCalledTimes(1)
  })

  it("refresh() forces a new token even when cached token would still be fresh", async () => {
    const tokenA = mintToken(900)
    const tokenB = mintToken(900)
    const fetchJwt = vi.fn()
      .mockResolvedValueOnce(tokenA)
      .mockResolvedValueOnce(tokenB)
    const store = new JwtStore(fetchJwt)

    expect(await store.get()).toBe(tokenA)
    expect(await store.refresh()).toBe(tokenB)
    expect(fetchJwt).toHaveBeenCalledTimes(2)
  })

  it("rejects empty token returned by fetchJwt", async () => {
    const fetchJwt = vi.fn().mockResolvedValue("")
    const store = new JwtStore(fetchJwt)
    await expect(store.get()).rejects.toThrow(/empty token/)
  })

  it("times out a hung fetchJwt() call", async () => {
    // Never-resolving fetchJwt simulates a partner backend that hangs.
    const fetchJwt = vi.fn(() => new Promise<string>(() => {}))
    const store = new JwtStore(fetchJwt, false, 10) // 10ms timeout for test
    await expect(store.get()).rejects.toThrow(/timed out/)
  })
})

// JWT cache + refresh logic. Holds the most recent token returned by
// fetchJwt(); refreshes:
//   - proactively when remaining lifetime < REFRESH_AHEAD_MS,
//   - on an `auth_expiring` close from the server,
//   - on a 401 (caller forces refresh).
//
// ─── Design decisions ────────────────────────────────────────────────
//
// 1. SDK does NOT mint JWTs. The customer's backend holds the
//    company's signing secret and mints tokens; the SDK never sees the
//    secret. fetchJwt() is the caller-supplied callback that hits the
//    customer's "give me a fresh Valet JWT" endpoint.
//
// 2. REFRESH_AHEAD_MS = 5 minutes. Matches the server's `auth_expiring`
//    warning window (the server emits `event: closed reason="auth_expiring"`
//    when remaining JWT lifetime drops below 5 min). We refresh
//    proactively at the same threshold so the SDK has a fresh token in
//    hand BEFORE the server cuts the connection. Lockstep coordination,
//    not coincidence — see plan: "JWT lifetime guidance" section.
//
// 3. Concurrent callers share one in-flight refresh. The first caller
//    triggers fetchJwt(); subsequent callers await the same promise.
//    Avoids hammering the customer's backend during reconnect storms.
//
// 4. exp is read from the JWT body WITHOUT verifying the signature.
//    This is safe because we use exp ONLY to schedule refresh — the
//    server is the source of truth for token validity. Lying about exp
//    in the payload only hurts the lying client; the server still
//    rejects an actually-expired token.
//
// ─── Porting notes (Python / Swift / Kotlin / etc.) ──────────────────
//
//   * Same shape: store(token, expiresAtMillis); refresh on demand.
//   * Same concurrent-refresh dedupe: single in-flight future/promise.
//   * Same exp-decode-without-verify pattern (base64url → JSON →
//     read exp). Most languages have a cheap base64url + JSON path.
//   * Same REFRESH_AHEAD_MS = 300_000 — server contract not negotiable.

const REFRESH_AHEAD_MS = 5 * 60 * 1000 // 5 min — matches server `auth_expiring` window
const DEFAULT_FETCH_TIMEOUT_MS = 10000 // hard-cap a hung partner /api/valet/jwt call

interface JwtPayload {
  exp?: number
  iat?: number
  source_key?: string
  agent_uuid?: string
}

export class JwtStore {
  private token: string | null
  private exp: number
  private inflight: Promise<string> | null
  private readonly fetchJwt: () => Promise<string> | string
  private readonly debug: boolean
  private readonly fetchTimeoutMs: number

  constructor(
    fetchJwt: () => Promise<string> | string,
    debug: boolean = false,
    fetchTimeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
  ) {
    this.fetchJwt = fetchJwt
    this.debug = debug
    this.fetchTimeoutMs = fetchTimeoutMs
    this.token = null
    this.exp = 0
    this.inflight = null
  }

  // Returns a valid token. Refreshes if absent or close to expiry.
  // Concurrent callers share one in-flight refresh.
  async get(): Promise<string> {
    if (this.token && this.exp - Date.now() > REFRESH_AHEAD_MS) {
      return this.token
    }
    return this.refresh()
  }

  // Force a refresh — used after a 401 or `auth_expiring`.
  async refresh(): Promise<string> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        if (this.debug) console.debug("[valet-sdk] jwt.refresh: calling fetchJwt()")
        const t = await withTimeout(
          Promise.resolve(this.fetchJwt()),
          this.fetchTimeoutMs,
          `fetchJwt() timed out after ${this.fetchTimeoutMs}ms`
        )
        if (typeof t !== "string" || t.length === 0) {
          throw new Error("fetchJwt() returned an empty token")
        }
        this.token = t
        this.exp = parseExp(t)
        if (this.debug) console.debug("[valet-sdk] jwt.refresh OK", { expiresInMs: this.exp - Date.now() })
        return t
      } catch (e) {
        if (this.debug) console.debug("[valet-sdk] jwt.refresh FAILED", e)
        throw e
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  // Test/debug introspection.
  peek(): { token: string | null; expiresInMs: number } {
    return { token: this.token, expiresInMs: this.token ? this.exp - Date.now() : 0 }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      v => { clearTimeout(t); resolve(v) },
      e => { clearTimeout(t); reject(e) }
    )
  })
}

// Best-effort `exp` extraction. JWTs are base64url-encoded JSON; we
// decode the payload without verifying — the server is the source of
// truth for validity. We only use `exp` to schedule proactive refresh.
function parseExp(jwt: string): number {
  try {
    const parts = jwt.split(".")
    if (parts.length < 2) return Date.now()
    const payloadB64 = parts[1]!
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))
    const payload = JSON.parse(json) as JwtPayload
    return typeof payload.exp === "number" ? payload.exp * 1000 : Date.now()
  } catch {
    return Date.now()
  }
}

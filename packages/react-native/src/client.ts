// ValetClient (React Native) — same surface as the browser SDK's
// ValetClient. The only difference is the Convo it constructs uses the
// RN transport + AppState lifecycle.

import type {
  AttachmentPolicy,
  LockoutSnapshot,
  OpenConvoOptions,
  StartSessionResult,
  ValetClientConfig
} from "@valet.red/sdk-core"
import { JwtStore } from "@valet.red/sdk-core"
import { Convo } from "./convo"

const DEFAULT_BASE_URL = "https://api.valet.red"

// Sane fallbacks if the server omits these fields (older Valet build
// against newer SDK). Real values always come from the server.
const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = {
  max_files_per_message: 0,
  max_files_per_convo:   0,
  max_file_size_bytes:   0,
  allowed_mime_types:    []
}
const DEFAULT_LOCKOUT: LockoutSnapshot = {
  locked_out:   false,
  expires_at:   null,
  permanent:    false,
  reason:       null,
  user_message: null
}

export class ValetClient {
  private readonly agentId:           string
  private readonly baseUrl:           string
  private readonly jwt:               JwtStore
  private readonly debug:             boolean
  private readonly pauseOnBackground: boolean

  constructor(cfg: ValetClientConfig) {
    if (!cfg.agentId) throw new Error("ValetClient: agentId is required")
    if (typeof cfg.fetchJwt !== "function") throw new Error("ValetClient: fetchJwt callback is required")
    this.agentId           = cfg.agentId
    this.baseUrl           = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.debug             = cfg.debug === true
    // Reuses the browser SDK's `pauseOnHidden` config name for parity —
    // here it controls AppState background/foreground pausing instead
    // of document visibility.
    this.pauseOnBackground = cfg.pauseOnHidden !== false
    this.jwt               = new JwtStore(cfg.fetchJwt, this.debug, cfg.fetchJwtTimeoutMs)
    if (this.debug) console.debug("[valet-sdk-rn] ValetClient created", { agentId: this.agentId, baseUrl: this.baseUrl })
  }

  async openConvo(opts: OpenConvoOptions): Promise<Convo> {
    if (!opts.convoId) throw new Error("openConvo: convoId is required")
    await this.jwt.get()
    if (this.debug) console.debug("[valet-sdk-rn] openConvo", { convoId: opts.convoId })
    const convo = new Convo({
      agentId:           this.agentId,
      convoId:           opts.convoId,
      baseUrl:           this.baseUrl,
      jwt:               this.jwt,
      debug:             this.debug,
      pauseOnBackground: this.pauseOnBackground
    })
    convo.start()
    return convo
  }

  async startSession(): Promise<StartSessionResult> {
    const url = `${this.baseUrl}/api/v2/sessions`
    if (this.debug) console.debug("[valet-sdk-rn] startSession →", url)
    const jwt = await this.jwt.get()
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json"
      }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      if (this.debug) console.debug("[valet-sdk-rn] startSession FAILED", { status: res.status, body: txt })
      throw new Error(`startSession failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
    }
    const body = await res.json() as {
      convo_id?:          string
      attachment_policy?: AttachmentPolicy
      lockout?:           LockoutSnapshot
    }
    if (!body.convo_id) throw new Error("startSession: server returned no convo_id")
    if (this.debug) console.debug("[valet-sdk-rn] startSession OK", { convoId: body.convo_id })
    return {
      convoId:          body.convo_id,
      attachmentPolicy: body.attachment_policy ?? DEFAULT_ATTACHMENT_POLICY,
      lockout:          body.lockout ?? DEFAULT_LOCKOUT
    }
  }

  async listConvos(): Promise<Array<{ id: string; state: string; closed: boolean; last_message_at: string | null; created_at: string }>> {
    const url = `${this.baseUrl}/api/v2/agent_convos`
    if (this.debug) console.debug("[valet-sdk-rn] listConvos →", url)
    const jwt = await this.jwt.get()
    const res = await fetch(url, {
      method:  "GET",
      headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      if (this.debug) console.debug("[valet-sdk-rn] listConvos FAILED", { status: res.status, body: txt })
      throw new Error(`listConvos failed: HTTP ${res.status}${txt ? " — " + txt : ""}`)
    }
    const body = await res.json() as { agent_convos?: Array<any> }
    if (this.debug) console.debug("[valet-sdk-rn] listConvos OK", { count: body.agent_convos?.length ?? 0 })
    return body.agent_convos ?? []
  }
}

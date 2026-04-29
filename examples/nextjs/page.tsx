// app/chat/page.tsx — Next.js 14+ App Router example.
//
// Pattern:
//   - This page is a Client Component (it manages SSE state).
//   - The /api/valet/jwt route (in app/api/valet/jwt/route.ts — see
//     adjacent file) is a Server Component endpoint that mints the
//     JWT using the company's secret from process.env.VALET_JWT_SECRET.
//   - The browser SDK calls fetchJwt() → that route → gets a fresh token.

"use client"

import { useEffect, useRef, useState } from "react"
import { ValetClient, type Convo, type Message } from "@valet/sdk"

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState("")
  const convoRef = useRef<Convo | null>(null)

  useEffect(() => {
    const valet = new ValetClient({
      agentUuid: process.env.NEXT_PUBLIC_VALET_AGENT_UUID!,
      fetchJwt: () => fetch("/api/valet/jwt").then(r => r.text())
    })

    let mounted = true
    void (async () => {
      const convoUuid = await fetch("/api/valet/convo", { method: "POST" }).then(r => r.text())
      const c = await valet.openConvo({ convoUuid })
      if (!mounted) { c.close(); return }
      convoRef.current = c
      c.on("message", ({ message }) => setMessages(prev => [...prev, message]))
    })()

    return () => {
      mounted = false
      convoRef.current?.close()
    }
  }, [])

  return (
    <div className="chat">
      {messages.map(m => <div key={m.uuid}>{m.content}</div>)}
      <form onSubmit={async (e) => {
        e.preventDefault()
        if (!text.trim() || !convoRef.current) return
        await convoRef.current.send(text)
        setText("")
      }}>
        <input value={text} onChange={e => setText(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}

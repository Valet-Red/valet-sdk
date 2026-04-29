// Minimal React example — drop into a Vite/Next.js/CRA app.
// Demonstrates the standard "open convo on mount, render messages, send on submit" shape.

import React, { useEffect, useRef, useState } from "react"
import { ValetClient, type Convo, type Message } from "@valet/sdk"

interface ChatProps {
  agentUuid: string
  convoUuid: string
}

export function Chat({ agentUuid, convoUuid }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [typingLabel, setTypingLabel] = useState<string | null>(null)
  const [text, setText] = useState("")
  const convoRef = useRef<Convo | null>(null)

  useEffect(() => {
    const valet = new ValetClient({
      agentUuid,
      fetchJwt: () => fetch("/api/valet/jwt").then(r => r.text())
    })

    let mounted = true
    void (async () => {
      const c = await valet.openConvo({ convoUuid })
      if (!mounted) { c.close(); return }
      convoRef.current = c

      c.on("message", ({ message }) => {
        setMessages(prev => [...prev, message])
      })
      c.on("typing", ({ state, label }) => {
        setTypingLabel(state === "start" ? label : null)
      })
    })()

    return () => {
      mounted = false
      convoRef.current?.close()
    }
  }, [agentUuid, convoUuid])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || !convoRef.current) return
    const t = text
    setText("")
    await convoRef.current.send(t)
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.map(m => (
          <div key={m.uuid} className={`msg from-${m.from}`}>{m.content}</div>
        ))}
      </div>
      {typingLabel && <div className="typing">{typingLabel}</div>}
      <form onSubmit={onSubmit}>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}

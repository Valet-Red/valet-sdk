# @valet.red/sdk-react-native

React Native SDK for Valet's per-convo Server-Sent Events stream + outbound `stream_message`. Same API surface as the browser SDK ([@valet.red/sdk](https://www.npmjs.com/package/@valet.red/sdk)) — adapted for native: `react-native-sse` for the SSE transport, `AppState` for foreground/background lifecycle, no tab-leader (single app process).

```bash
npm install @valet.red/sdk-react-native react-native-sse
```

`react-native-sse` is a peer dependency — install it alongside this package. Requires React Native 0.71+ (for the global `atob`).

## Quickstart

```tsx
import React, { useEffect, useRef, useState } from "react"
import { View, Text, TextInput, Button, FlatList } from "react-native"
import { ValetClient, type Convo, type Message } from "@valet.red/sdk-react-native"

export function Chat({ agentId }: { agentId: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText]         = useState("")
  const convoRef                = useRef<Convo | null>(null)

  useEffect(() => {
    const valet = new ValetClient({
      agentId,
      // your backend mints HS256 JWTs; never put VALET_JWT_SECRET in the app
      fetchJwt: () => fetch("https://yourapp.com/api/valet/jwt").then(r => r.text())
    })

    let mounted = true
    ;(async () => {
      const { convoId } = await valet.startSession()
      const c           = await valet.openConvo({ convoId })
      if (!mounted) { c.close(); return }
      convoRef.current = c

      c.on("message", ({ message }) => setMessages(prev => [...prev, message]))
    })()

    return () => {
      mounted = false
      convoRef.current?.close()
    }
  }, [agentId])

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={messages}
        keyExtractor={m => m.id}
        renderItem={({ item }) => <Text>{item.from}: {item.content}</Text>}
      />
      <TextInput value={text} onChangeText={setText} placeholder="Type…" />
      <Button title="Send" onPress={() => { void convoRef.current?.send(text); setText("") }} />
    </View>
  )
}
```

## What's the same as the browser SDK

- Public surface: `ValetClient`, `Convo`, all wire types.
- `startSession()`, `openConvo()`, `convo.send()`, `convo.close()`, `convo.on(...)`, `convo.uploadFiles(...)` — same names, same behavior.
- JWT cache + proactive refresh ~5 min before expiry, retry-once on 401, hard cap on `fetchJwt()`.
- Reconnect protocol: close-reason switch + exponential backoff (250ms → 30s) + immediate reconnect on graceful server closes.
- Reconcile-fetch + UUID dedupe across reconnects.
- 401 circuit breaker after 3 consecutive failures.

## What's different (native specifics)

- **SSE transport:** [`react-native-sse`](https://github.com/binaryminds/react-native-sse). Native HTTP streaming on iOS (URLSession) and Android (OkHttp), instead of browser `fetch` + `ReadableStream`.
- **No tab-leader.** RN apps are a single foreground process; the server-side per-(appuser, agent) cap of 2 absorbs reconnect overlap with no client coordination needed.
- **AppState lifecycle.** `Convo` listens to `AppState.addEventListener("change", …)`. On `background` / `inactive` the SSE stream closes (releases the slot server-side); on `active` it reopens. Set `pauseOnHidden: false` on `ValetClient` to opt out — your stream stays alive across app suspension (and risks zombie slots when iOS / Android suspend the app for an extended period).
- **`uploadFiles` argument shape.** RN uses `{ uri, name, type }` objects instead of browser `File` instances:
  ```ts
  await convo.uploadFiles([{ uri: "file:///path/to/image.png", name: "image.png", type: "image/png" }])
  ```

## Config reference

```ts
new ValetClient({
  agentId:           string                                 // required
  fetchJwt:          () => Promise<string> | string         // required; mints a fresh JWT from your backend
  baseUrl?:          string                                 // default https://api.valet.red
  debug?:            boolean                                // verbose console.debug logging
  fetchJwtTimeoutMs?: number                                // default 10000
  pauseOnHidden?:    boolean                                // default true; here it controls AppState pausing
})
```

## License

MIT. See [LICENSE](LICENSE).

## Going deeper

- Browser SDK: [@valet.red/sdk](https://www.npmjs.com/package/@valet.red/sdk)
- Integration guide: https://app.valet.red/docs/platform/integration
- Realtime events / raw protocol: https://app.valet.red/docs/platform/realtime-events
- Source: https://github.com/Valet-Red/valet-sdk

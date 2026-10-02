# Request flow — one chat round-trip, end to end

What happens, in order, when a user calls `POST /v1/chat/completions` on the proxy.

## 0. Prerequisites loaded at process start

- `./session.json` on disk (from a prior `npm run bootstrap` run).
- 5 protobuf descriptors loaded via `src/proto/loader.ts` using `protobufjs` `Root.fromDescriptor`.
- Hono server listening on `127.0.0.1:8787`.

## 1. Incoming request

```
POST http://127.0.0.1:8787/v1/chat/completions
Content-Type: application/json
Authorization: Bearer anything

{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}
```

Middleware logs `[req ] POST /v1/chat/completions`. Handler calls `extractUserText(messages)` → flattens to a single string.

## 2. Fresh Noise session

```ts
const client = new HatchClient({ sessionPath: "./session.json" });
// This:
// a) Opens WS via globalThis.WebSocket(sess.ws_url)
// b) Noise XX handshake (src/noise/handshake.ts):
//    - writeMessage(0x0a 0x20 + randomBytes(32)) -> send msg1 (66B)
//    - recv -> readMessage(msg2) decrypts 70B payload
//    - writeMessage(new Uint8Array(0)) -> send msg3 (64B)
// c) [csSend, csRecv] = hs.split()
```

If step (a) fails, `src/server/handler.ts` calls `src/bootstrap/session.ts` to re-bootstrap and retries **once**.

## 3. Register as the push target

```ts
await client.request("POST", "/client/register-capabilities", {
    client_id: "<fresh uuid>", platform: "web",
    display_name: "muse-proxy", version: "0.0.0",
    capabilities: { ...minimal },
});
```

Server-side: this binds the next `/chat/subscribe` on this Noise connection to the given `client_id`.

## 4. Open the subscribe stream

```ts
const subSid = await client.request("POST", "/chat/subscribe", {
    after_stream_seq: 0, after_chat_event_seq: 0,
    capabilities: ["chat_cancel", "delta_stream", "custom_reactions", ...],
});
```

Server returns an immediate `response` frame on `subSid` with HTTP status 200. **Does not** set `end_body=true` — this stream will keep delivering `body_chunk` frames (each a complete JSON event) until the Noise session closes.

Server also replays all historic events after `after_chat_event_seq=0` as a burst of events on this stream. We filter those out below by timestamp.

## 5. Send the user message

Record `sendStartMs = Date.now()` **before** firing the request.

```ts
const sendSid = await client.request("POST", "/chat/stream", {
    message: userText,
    node_id: clientId,         // SAME uuid as register-capabilities
    capabilities: [...],
    timezone: "Asia/Calcutta",
});
```

If `userText` is large (Claude Code often is), `request()` auto-chunks the serialized ServiceRequest across multiple `NoiseTransportFrame` chunks (`chunk_id` groups them, `chunk_index` sequences them, `MAX_CHUNK_PAYLOAD = 48KB`).

Server replies on `sendSid` with HTTP 200 + a JSON body:
```json
{"channel":"main","is_thread":false,
 "message_id":"<uuid>","reply_to_message_id":"<uuid>",
 "session_id":"<chat session uuid>"}
```

This is the sync ack — the server has accepted the message. The agent now starts processing in the background.

## 6. Collect the stream

Loop calling `client._recvOne()`:

```ts
while (!gotDone && Date.now() < deadline) {
    const r = await client._recvOne();
    if (r === null) continue;                    // timeout, keep polling
    if (r === "closed") break;                   // server closed
    const { sid, kind, obj } = r;

    if (kind === "complete" && sid === sendSid) {
        // sync ack from step 5
        const ack = obj; continue;
    }

    if (kind !== "event") continue;              // ignore other sync responses

    if ((obj.ts_ms ?? 0) < sendStartMs) continue; // drop catch-up replay

    const { event, payload } = obj;
    if (event === "delta.text_append") {
        textParts.push(payload.text);
        onDelta(payload.text);                   // stream to client (if SSE)
    } else if (event === "delta.message_done") {
        // Short replies may have no text_append — pull from transcript
        if (!textParts.length) {
            for (const m of payload.transcript.messages)
                for (const c of m.content)
                    if (c.type === "text") textParts.push(c.text);
        }
        gotDone = true;
    }
}
```

## 7. Shape the response

**Non-streaming request** → return a single JSON (OpenAI or Anthropic format, see `openai-compat.md` / `anthropic-compat.md`).

**Streaming request** → Hono `streamSSE` wraps an async generator that pulls deltas and emits SSE lines in the right format:
- OpenAI: `data: {chunk json}\n\n`, then `data: [DONE]\n\n`
- Anthropic: `event: X\ndata: {json}\n\n` for each of `message_start`, `content_block_start`, `content_block_delta` ×N, `content_block_stop`, `message_delta`, `message_stop`.

## 8. Close

`client.close()` (idempotent) tears down the Noise WS. Response is logged `[resp] POST /v1/chat/completions 200 (NNNms)`.

## Total latency

- Noise handshake: ~400ms (3 RTT to hatch.metaaivm.com)
- Register + subscribe: ~200ms (2 RTT)
- Send: ~100ms (1 RTT for sync ack)
- Agent generation: variable (fast for short replies, slow for long or tool-using ones)
- Our per-request overhead on top of model time: ~700ms.

To reduce: pool Noise connections. Not done because it complicates `register-capabilities` scoping (the push subscription is per-connection).

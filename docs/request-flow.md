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
X-Muse-Session: alpha              # optional — routes to a dedicated side chat

{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}
```

Middleware logs `[req ] POST /v1/chat/completions`. Handler calls `extractUserText(messages)` → flattens to a single string, derives `sessionKey` via `deriveSessionKey({xMuseSession, authorization})`:
- `X-Muse-Session` header present → `h:<value>` (dedicated side chat on muse.ai)
- else `Authorization` header → `a:<sha256-16>` of the bearer (dedicated per-API-key side chat)
- else → `default` (shared main chat; backward compatible)

The `SessionStore` (24h sliding TTL, LRU eviction, mapping persisted to `./sessions-store.json` so named sessions resume across proxy restarts) issues a stable `{sessionId, nodeId}` per sessionKey. `sessionId` is a client-chosen UUID that first-use creates the side chat on muse; `nodeId` identifies our client across calls so muse routes replies back to us.

## 2. Pool checkout (fresh Noise session on first request only)

```ts
const pool = getPool(cfg);                  // module-level singleton in src/server/handler.ts
return await pool.withClient(async (client) => {
    // ...register + subscribe + stream + collect
});
```

`src/hatch/pool.ts` holds one `HatchClient` in a slot. Only the first open is mutex'd; after that concurrent `withClient` callers run `fn` in parallel on the same client. `HatchClient` runs a background dispatcher that routes decrypted events into per-`stream_id` queues; `recvOne(sid)` pops from the right queue so overlapping requests don't steal each other's events. The handshake cost is paid once by the first caller. If `fn` throws, the pool closes the client and nulls the slot; other in-flight callers see `"closed"` from `recvOne` and fall through to the handler's bootstrap retry path.

If the first `pool.withClient` call fails (open or in-flight error), `src/server/handler.ts` calls `src/bootstrap/session.ts` to re-bootstrap and retries **once**.

## 3. Register as the push target

```ts
const nodeId = sessionState?.nodeId ?? randomUUID();

client.request("POST", "/api/nodes/register", {
    node_id: nodeId, display_name: "muse-proxy", platform: "windows",
    commands_v2: { ping: { description: "Connection liveness check" } },
});

client.request("POST", "/client/register-capabilities", {
    client_id: nodeId, platform: "web",
    display_name: "muse-proxy", version: "0.0.0",
    capabilities: { ...minimal },
});
```

Both registrations use the SAME `nodeId` (= `sessionState.nodeId` so it's stable across calls for the same API session). Without `/api/nodes/register`, side-chat events never route back to our connection.

## 4. Open the subscribe stream

```ts
const subBody: Record<string, unknown> = {
    after_stream_seq: 0, after_chat_event_seq: 0,
    capabilities: ["chat_cancel", "delta_stream", "custom_reactions", ...],
};
// Side chat: scope subscribe to the thread so replay captures its event history.
if (sessionState?.sessionId) subBody.session_id = sessionState.sessionId;
const subSid = client.request("POST", "/chat/subscribe", subBody);
```

Server returns an immediate `response` frame on `subSid` with HTTP status 200. **Does not** set `end_body=true` — this stream will keep delivering `body_chunk` frames (each a complete JSON event) until the Noise session closes. `HatchClient.hasResponded(sid)` returns true once that first response frame has been seen; we use it to gate the dependent `/chat/stream` call for main chat.

Server replays all historic events after `after_chat_event_seq=0`. We drop pre-sendStartMs events for main chat, but keep replays for side chats so the first-message reply (which may have fired before subscribe attached) comes through.

## 5. Send the user message

For main chat we wait for subscribe to attach (`hasResponded(subSid) === true`) before firing to avoid losing early deltas. For side chats we fire first — the thread must exist on the server before the scoped subscribe makes sense.

```ts
const streamBody: Record<string, unknown> = {
    message: userText,
    node_id: nodeId,                    // SAME uuid as register-capabilities
    capabilities: [...],
    timezone: "Asia/Calcutta",
};
if (sessionState?.sessionId) {
    streamBody.session_id = sessionState.sessionId;       // client-chosen thread UUID
    streamBody.metadata   = { thread_is_dictation_used: false };
}
const sendSid = client.request("POST", "/chat/stream", streamBody);
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

Loop pulling events, accumulating text until `delta.message_done` or `message.assistant`:

```ts
while (!done && Date.now() < deadline) {
    const r = await client.recvOne();
    if (r === null) continue;
    if (r === "closed") break;

    if (r.kind === "complete" && r.streamId === sendSid) {
        ackMessageId = r.body.message_id;      // sync ack
        continue;
    }
    if (r.kind !== "event") continue;

    // Main chat: drop replay by ts_ms. Side chat: keep replay — first-message
    // reply may be in replay because subscribe attached after the agent fired.
    if (!sessionId && r.obj.ts_ms < sendStartMs) continue;

    if (r.obj.event === "delta.text_append")  textParts.push(r.obj.payload.text);
    if (r.obj.event === "delta.message_done") { ...pull transcript if empty; break }
    if (r.obj.event === "message.assistant")  { ...push display_text; break }

    // Widget / card / inline-option events are collected into `presentations[]`
    // and forwarded to the server layer as they arrive; see §7 for the wire
    // extension used to surface them. Main chat only — side-chat polling never
    // sees these events.
    if (PRESENTATION_KINDS.has(r.obj.event)) {
        presentations.push({ kind: r.obj.event, ts_ms: r.obj.ts_ms, payload: r.obj.payload });
        onPresentation?.(last);
    }
}
```

The loop also respects `args.signal?.aborted` — a disconnected HTTP client sets the signal, every `while` condition checks it, and the loop breaks with whatever text was collected.

**Fallback — side chat first-message race:** if a side chat yields no text parts after the loop finishes, poll `GET /chat/history?limit=40&transcript_mode=messages&session_id=<thread>` and extract the first `message.assistant` entry whose index is after our sent `message_id`. The thread existed on the server before subscribe attached, so the stored reply is always retrievable.

## 7. Shape the response

**Non-streaming request** → return a single JSON (OpenAI or Anthropic format, see `openai-compat.md` / `anthropic-compat.md`).

**Streaming request** → Hono `streamSSE` wraps an async generator that pulls deltas and emits SSE lines in the right format:
- OpenAI: `data: {chunk json}\n\n`, then an optional `data: {choices: [], usage: {...}}` chunk, then `data: [DONE]\n\n`. Presentation events (if any) interleave as `data: {choices: [], x_muse_presentation: {...}}` chunks in arrival order.
- Anthropic: `event: X\ndata: {json}\n\n` for each of `message_start`, `content_block_start`, `content_block_delta` ×N, `content_block_stop`, `message_delta`, `message_stop`. Presentation events interleave as `event: x_muse_presentation\ndata: {json}` frames in arrival order.

**Non-streaming request** carries `usage: {prompt_tokens, completion_tokens, total_tokens}` (OpenAI) or `usage: {input_tokens, output_tokens}` (Anthropic) computed as chars/4. If any presentations were captured, a top-level `x_muse_presentations: PresentationEvent[]` is attached. Not a tokenizer, just an estimate — Hatch exposes no token count.

## 8. Close

`client.close()` (idempotent) tears down the Noise WS. Response is logged `[resp] POST /v1/chat/completions 200 (NNNms)`.

## Total latency

- Noise handshake: ~400ms (3 RTT to hatch.metaaivm.com)
- Register + subscribe: ~200ms (2 RTT)
- Send: ~100ms (1 RTT for sync ack)
- Agent generation: variable (fast for short replies, slow for long or tool-using ones)
- Our per-request overhead on top of model time: ~700ms.

To reduce: pool Noise connections. Not done because it complicates `register-capabilities` scoping (the push subscription is per-connection).

# Request flow — one chat round-trip, end to end

What happens, in order, when a user calls `POST /v1/chat/completions` on the Phase 7 proxy.

## 0. Prerequisites loaded at process start

- `phase1/session.json` on disk (from a prior `python phase1/bootstrap.py` run).
- 5 protobuf descriptors loaded into a `DescriptorPool` by `phase4/chat.py:load_pool()`.
- FastAPI server listening on `127.0.0.1:8787`.

## 1. Incoming request

```
POST http://127.0.0.1:8787/v1/chat/completions
Content-Type: application/json
Authorization: Bearer anything

{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}
```

Middleware logs `[req ] POST /v1/chat/completions`. Handler calls `_extract_user_text(messages)` → flattens to a single string.

## 2. Fresh Noise session

In a thread (so the asyncio loop stays free):

```python
client = HatchClient(session_path="phase1/session.json")
# This:
# a) Opens WS via curl_cffi.Session(impersonate="chrome").ws_connect(sess["ws_url"], timeout=15)
# b) Noise XX handshake:
#    - write_message(0x0a 0x20 <32 CSPRNG>) -> send msg1 (66B)
#    - recv -> read_message(msg2) decrypts 70B payload
#    - write_message(b"") -> send msg3 (64B)
# c) (cs_send, cs_recv) = split()
```

If step (a) fails, `server.py:_refresh_session()` runs `phase1/bootstrap.py` subprocess and we retry **once**.

## 3. Register as the push target

```python
client.request("POST", "/client/register-capabilities", body={
    "client_id": "<fresh uuid>", "platform": "web",
    "display_name": "muse-proxy", "version": "0.0.0",
    "capabilities": {...minimal...},
})
```

Server-side: this binds the next `/chat/subscribe` on this Noise connection to the given `client_id`.

## 4. Open the subscribe stream

```python
sub_sid = client.request("POST", "/chat/subscribe", body={
    "after_stream_seq": 0, "after_chat_event_seq": 0,
    "capabilities": ["chat_cancel","delta_stream","custom_reactions",...]
})
```

Server returns an immediate `response` frame on `sub_sid` with HTTP status 200. **Does not** set `end_body=true` — this stream will keep delivering `body_chunk` frames (each a complete JSON event) until the Noise session closes.

Server also replays all historic events after `after_chat_event_seq=0` as a burst of events on this stream. We filter those out below by timestamp.

## 5. Send the user message

Record `send_start_ms = now_ms()` **before** firing the request.

```python
send_sid = client.request("POST", "/chat/stream", body={
    "message": user_text,
    "node_id": client_id,         # SAME uuid as register-capabilities
    "capabilities": [...],
    "timezone": "Asia/Calcutta",
})
```

If `user_text` is large (Claude Code often is), `request()` auto-chunks the serialized ServiceRequest across multiple `NoiseTransportFrame` chunks (chunk_id groups them, chunk_index sequences them, MAX_CHUNK_PAYLOAD = 48KB).

Server replies on `send_sid` with HTTP 200 + a JSON body:
```json
{"channel":"main","is_thread":false,
 "message_id":"<uuid>","reply_to_message_id":"<uuid>",
 "session_id":"<chat session uuid>"}
```

This is the sync ack — the server has accepted the message. The agent now starts processing in the background.

## 6. Collect the stream

Loop calling `client._recv_one()`:

```python
while not got_done and time.time() < deadline:
    r = client._recv_one()
    if r is None: continue                          # timeout, keep polling
    if r == "closed": break                          # server closed
    sid, kind, obj = r

    if kind == "complete" and sid == send_sid:
        # sync ack from step 5
        ack = obj["obj"]; continue

    if kind != "event": continue                     # ignore other sync responses

    if obj.get("ts_ms", 0) < send_start_ms:         # drop catch-up replay
        continue

    ev = obj["event"]; payload = obj["payload"]
    if ev == "delta.text_append":
        text_parts.append(payload["text"])
        on_delta(payload["text"])                    # stream to client (if SSE)
    elif ev == "delta.message_done":
        # Short replies may have no text_append — pull from transcript
        if not text_parts:
            for m in payload["transcript"]["messages"]:
                for c in m["content"]:
                    if c["type"] == "text": text_parts.append(c["text"])
        got_done = True
```

## 7. Shape the response

**Non-streaming request** → return a single JSON (OpenAI or Anthropic format, see `openai-compat.md` / `anthropic-compat.md`).

**Streaming request** → `StreamingResponse` wraps an async generator that pulls deltas off an `asyncio.Queue` fed from `on_delta` and emits SSE lines in the right format:
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

# Phase 5 — Capture the streamed assistant reply (02-10-2026)

## Goal

The Phase 4 send gets a sync ack but the assistant's streamed reply goes to the browser's existing Noise connection, not ours. Find and reproduce the subscription step that makes the server push events to us.

## What I tried

1. **Dumped ALL encrypted ServiceRequests the browser sends on page load**, extracted verb+path by regex. Found 27 distinct routes. Standouts:
   - `POST /navigation/subscribe`, `POST /identity/subscribe`, `POST /themes/subscribe`, `POST /spaces/subscribe`, `POST /artifacts/subscribe`, `POST /fs/subscribe`
   - **`POST /chat/subscribe`** — the one we want
   - `POST /client/register-capabilities` (sent BEFORE every subscribe)
2. **Extracted the JSON bodies** by scanning for `{...}` inside the plaintext hex:
   ```json
   POST /chat/subscribe
   { "after_stream_seq": 0, "after_chat_event_seq": 96,
     "capabilities": ["chat_cancel","delta_stream","custom_reactions",...] }
   ```
   ```json
   POST /client/register-capabilities
   { "client_id": "3d4d18af-...", "platform": "web", "display_name": "Muse Web",
     "version": "0.0.0", "capabilities": { ...1KB of UI capabilities... } }
   ```
3. **Added subscribe + register to `chat.py`** → still got only the sync ack. No pushed events.
4. **Logged stream_ids of all incoming decrypted frames from the browser capture.** Found that **ALL event frames (message.user, agent.status, delta.text_append, delta.message_done, chat.seen) arrive on `stream_id=12` — the stream_id the browser used for `/chat/subscribe`.** The subscribe response is long-lived: server keeps writing body_chunks on that same stream_id forever. `end_body` is NEVER set true on it.
5. **Fixed `_recv_one()` to emit each body_chunk's data as a self-contained JSON event immediately** instead of waiting for `end_body`. Events started flowing.
6. **Still only got old catch-up events, not fresh ones for my new message.** The subscribe replays everything after `after_chat_event_seq`. Filtered by `ts_ms < send_start_ms` to drop replay.
7. **With register + subscribe + ts filter in place → got the live `delta.text_append` events** streaming the agent's reply. End on `delta.message_done`.
8. **Final test:**
   ```
   send:  "say exactly: phase5-final-ok"
   reply: "phase5-final-ok"  (15 chars, streamed via delta.text_append, sealed by delta.message_done)
   ```

## What worked

- Full chat round-trip from Python:
  1. Noise handshake (phase 2)
  2. `POST /client/register-capabilities` with a fresh UUID `client_id`
  3. `POST /chat/subscribe` with `{after_stream_seq:0, after_chat_event_seq:0, capabilities:[...]}`
  4. `POST /chat/stream` with `{message, node_id: <same client_id>, capabilities, timezone}`
  5. Record body_chunks on the subscribe stream_id; each is one `{event, payload, ts_ms, seq}` JSON object
  6. Filter by `ts_ms >= send_start_ms` to drop catch-up replay
  7. Assemble `delta.text_append.payload.text` across events, stop on `delta.message_done`
  8. For non-streaming replies (no delta.text_append), extract from `delta.message_done.payload.transcript.messages[*].content[*].text`
- Event vocabulary (from capture): `message.user`, `agent.status`, `reactions.updated`, `delta.message_start`, `delta.text_append`, `delta.message_done`, `chat.seen`, `delta.presentation`, `widget.state_updated`, `task.status`, `approvals.snapshot`.

## Gotchas (worth remembering)

1. **Subscribe streams never end.** Each `body_chunk` on them is one complete JSON event. Don't wait for `end_body` — process each `body_chunk.data` as its own event immediately.
2. **Catch-up events swamp fresh ones.** Server replays all events after `after_chat_event_seq`. Pass `0` → everything replays. Use `ts_ms` filter in the client to drop pre-send events.
3. **Without `/client/register-capabilities`**, server routes pushed events to whichever client_id is currently registered (your open browser if there is one). Must register with a fresh UUID + use the SAME UUID as `node_id` in `/chat/stream`.
4. **`delta.text_append` may not fire at all** for very short replies — the full text arrives only inside `delta.message_done.payload.transcript`. Handle both.

## Deliverables

`phase4/chat.py` v2 — full round-trip, 230 lines, exposes `HatchClient` class and `send_and_collect_reply(user_text, timezone, listen_seconds)` for reuse in Phase 7.

## Next

Phase 7: wrap this behind OpenAI + Anthropic HTTP compat endpoints so any SDK can use it.

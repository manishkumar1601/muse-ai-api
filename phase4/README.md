# Phase 4 — send human chat messages from Python

Reverses the exact HTTP-over-Noise call the browser makes when a user types in the chat, and reproduces it from a standalone Python client. The message hits Meta's agent and is replied to by the real Muse personal agent.

**Status: send works end-to-end.** The message is routed, the agent processes it, and the reply appears in the normal chat timeline. Receiving the streamed reply on the Python side is one subscription-endpoint discovery away (Phase 5).

## How we found it

Phase 3's sweep found `POST /chat/send` with `kind=action` works but is explicitly not the human-chat path (`"chat.send over the local HTTP API requires kind=action"` is the server declining a human message). The human path lives elsewhere, and all literal path strings in the client bundle are either minified away or constructed dynamically.

Rather than keep guessing, we **monkey-patched `crypto.subtle.encrypt`** in the live browser via `page.addInitScript`, which gave us the exact plaintext of every Noise frame the browser was about to encrypt. Typing a chat message, we captured:

```
NoiseTransportFrame { chunk_id, chunk_index, total_chunks, payload }
  payload = ServiceRequest { service: DAEMON (default), payload: ServiceFrame bytes }
    ServiceFrame { stream_id, request:
      ApplicationRequest {
        verb: "POST"
        path: "/chat/stream"
        headers: [content-type: application/json, accept-language: en-US]
        body:  {"message": "...", "node_id": "<uuid>", "capabilities": [...], "timezone": "Asia/Calcutta"}
        end_body: true
      }
    }
```

So the real endpoint is `POST /chat/stream` (not `GET` — we tried `GET` in Phase 3 and got `"matched route missing from endpoint ACL"`). The verb matters.

## Install

```
pip install -r requirements.txt
```

## Run

```bash
python chat.py "hello muse"
python chat.py --message "..." --timezone America/New_York --listen-seconds 30 --save-events events.json
```

Needs a valid `../phase1/session.json` (rerun Phase 1 bootstrap if tokens are stale).

## What works

- Noise XX handshake, cipher-state split, HTTP-over-Noise framing, body-chunk assembly: all from Phase 2/3.
- POST a human chat message with the correct JSON body shape.
- Receive the **sync ack**: `{"channel":"main","is_thread":false,"message_id":"<uuid>","reply_to_message_id":"<uuid>","session_id":"<chat uuid>"}`.
- Message arrives in the real Hatch inbox: the server routes it to the agent, agent processes it, assistant reply appears in the normal chat UI with full context.

Verified end-to-end: `chat.py "say the word 'phase4' back to me, nothing else"` produced the browser-visible exchange:

```
You: say the word 'phase4' back to me, nothing else
phase4
```

## What doesn't work yet — the streaming reply gap

The server pushes assistant tokens as a stream of JSON events (`message.user`, `agent.status`, `delta.message_start`, `delta.text_append` ×N, `delta.message_done`, `chat.seen`, ...). Those events are **not** delivered on the stream_id we POSTed on, and they are **not** delivered to our Python Noise connection at all — they appear only on the browser's existing Noise connection.

Hypothesis: the Hatch VM routes server-pushed events based on an explicit subscription (likely a long-lived `GET`/`SUBSCRIBE` on `/chat/stream` or similar with specific headers), and the browser established that subscription at page-load time. Closing the browser WS doesn't help — the subscription endpoint has to be called from our end.

Phase 5 scope (not done): instrument the browser's initial post-handshake frames (not just the user-send flow) and find whichever route the browser calls at page load that leaves it registered as the push target. Candidates: a `GET /chat/stream` with specific headers (not the one Phase 3 sweep tried), a `GET /chat/subscribe`, or a `POST` with `Accept: text/event-stream`.

Once that endpoint is reproduced, `chat.py` just needs an extra background task that opens the subscription stream, then the `delta.text_append` deltas can be assembled into the final reply.

## The event vocabulary we already decoded (from the browser capture)

```
message.user         — echo of the user message
agent.status         — activity transitions: working / responding / online
reactions.updated    — emoji reactions (e.g. 👋 ack)
delta.message_start  — assistant message begins (stream_id, message_id)
delta.text_append    — one streamed text chunk (message_seq numbers)
delta.message_done   — assistant message complete (actions, chat_context)
chat.seen            — read receipt
```

Each event is a JSON object `{"event": "<name>", "payload": {...}}` wrapped in `body_chunk` frames, keyed by `message_id`. Reassembly is straightforward once events are received.

## Files

```
chat.py            — send a human message, print sync ack, listen for pushed events
requirements.txt   — curl_cffi, dissononce, protobuf
.gitignore         — chat_out.log, events.json
README.md          — this file
```

## Gotchas worth remembering

1. **Instrument crypto, not WebSocket.** AES-GCM is called from both the main thread and a Worker in the browser; the easiest way to see plaintext ServiceRequests is to patch `crypto.subtle.encrypt`/`decrypt` via `page.addInitScript` so it hits both scopes, then grep the hex log for an ASCII marker you type into the chat.
2. **Verb matters.** `GET /chat/stream` → `403 matched route missing from endpoint ACL`. `POST /chat/stream` → `200 OK`. The ACL is per-verb-per-path.
3. **`node_id`** is a fresh UUID per message in the browser's trace — not a stable "conversation id". It's effectively a client-side request correlation ID; the server returns its own `message_id` in the ack.
4. **`capabilities`** declared by the client controls the response shape. `delta_stream` opts into the streaming assistant tokens.
5. **Session multiplexing**: the server knows the user's `session_id` (`68b89aa9-...` in our case) across multiple Noise connections, and routes server-pushed events to one primary subscriber. Opening a new Noise connection and POSTing a message does not automatically subscribe that connection to the reply stream. Phase 5 problem.

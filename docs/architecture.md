# Architecture

## 30-second overview

```
   your OpenAI/Anthropic SDK or tool  ───┐
                                         │  HTTP (localhost)
                                         ▼
                             ┌─────────────────────────┐
                             │  phase7 FastAPI proxy   │
                             │  /v1/chat/completions   │
                             │  /v1/messages           │
                             │  /v1/messages/count_tokens
                             └───────────┬─────────────┘
                                         │  calls into
                                         ▼
                             ┌─────────────────────────┐
                             │  phase4 HatchClient     │
                             │  - fresh Noise XX       │
                             │  - register-caps        │
                             │  - subscribe            │
                             │  - send + collect       │
                             └───────────┬─────────────┘
                                         │  WebSocket + Noise
                                         ▼
                  wss://hatch.metaaivm.com/v1/noise?...
                                         │
                                         ▼
                             ┌─────────────────────────┐
                             │  per-user Hatch VM      │
                             │  (DAEMON HTTP router)   │
                             │  - /chat/stream         │
                             │  - /chat/subscribe      │
                             │  - /feed /ideas /goals  │
                             │  - /connectors ...      │
                             └───────────┬─────────────┘
                                         │  runs the real agent
                                         ▼
                                    Muse Spark (model)
                                    + agent memory
                                    + app connectors
                                    + attached files, etc.
```

## Layers

### 1. User-facing HTTP (phase7/server.py)

Standard FastAPI. Two shape adapters:

- **OpenAI shape** — `POST /v1/chat/completions`. Flattens `messages[]` → one prompt. Returns either a single JSON `chat.completion` or an SSE stream of `chat.completion.chunk`s terminated by `data: [DONE]`.
- **Anthropic shape** — `POST /v1/messages`. Same flattening. Returns either a single `message` JSON or SSE events matching Anthropic's `message_start / content_block_* / message_delta / message_stop` sequence.
- **Also** `GET /v1/models`, `GET /healthz`, `POST /v1/messages/count_tokens` (stub).

Auth: optional `MUSE_PROXY_KEY` env var checked against `Authorization: Bearer <key>` or `x-api-key: <key>`. Unset → open server (dev only).

### 2. Hatch client (phase4/chat.py)

`HatchClient` opens one Noise WS per request. Methods:
- `request(verb, path, body=None)` — fires one ApplicationRequest, returns the stream_id.
- `_recv_one()` — pulls one assembled frame (handles both `response`/`body_chunk` streams and self-contained JSON events on subscribe streams).
- `collect_until(pred, deadline_s)` — loop that keeps calling `_recv_one` until a predicate matches.

`send_and_collect_reply(user_text, timezone, listen_seconds)` orchestrates the three-call sequence:
1. `POST /client/register-capabilities` with a fresh UUID.
2. `POST /chat/subscribe`.
3. `POST /chat/stream` with the user text + same UUID as `node_id`.
4. Collect `delta.text_append` events until `delta.message_done`.

Payloads larger than 48KB are automatically split across multiple NoiseTransportFrame chunks.

### 3. Noise transport

- WebSocket to `wss://hatch.metaaivm.com/v1/noise?vm_id=&auth_token=&notary_token=&app_id=hatch-web&request_id=`.
- 3-message Noise XX handshake (initiator), AES-GCM transport ciphers after split.
- Each WS binary frame = one AES-GCM ciphertext of one `NoiseTransportFrame` protobuf.

### 4. Hatch VM (server-side)

Per-user VM at `<vm_id>.metaaivm.com`, fronted by the shared LB `hatch.metaaivm.com`. Runs a small internal HTTP router exposing JSON endpoints. The real agent (Muse Spark model + tools + memory) is behind the DAEMON service. SENTINEL/VAULT/AUTHD are support services only `/healthz`-reachable via noise.

### 5. Bootstrap chain (phase1/bootstrap.py)

Before the Noise WS can open, we need four HTTP POSTs on `muse.ai` with the user's session cookies:

1. `/api/hatch/lease-vm` — assigns a VM (403 if one already assigned; fall back to scraping the HTML).
2. `/api/hatch/vm/wake` — wakes the specific VM.
3. `/api/hatch/token` — short-lived EdDSA JWT bound to the VM.
4. `/api/hatch/noise-notary-token` — server-side attestation of the VM's Noise key chain.

All four responses + a locally-generated request_id get combined into the final `wss://` URL.

## Concurrency model

Each incoming OpenAI/Anthropic request → one fresh Noise handshake → one send-and-collect round-trip. Handshake overhead ~500ms per request. Not pooled.

The FastAPI event loop stays free: Hatch work runs in a thread via `loop.run_in_executor`. Streaming deltas get pushed through `loop.call_soon_threadsafe(queue.put_nowait, ...)` to the SSE generator.

## State

- **Persistent across runs:** `~/.ssh/*` (your git keys), `phase1/storage_state.json` (your muse.ai cookies), `phase1/session.json` (last-bootstrapped tokens).
- **Rebuilt per run:** everything else. Noise keys are per-handshake; stream_ids per-connection; the WS session itself is per-request.

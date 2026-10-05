# Architecture

## 30-second overview

```
   your OpenAI/Anthropic SDK or tool  ───┐
                                         │  HTTP (localhost)
                                         ▼
                             ┌─────────────────────────┐
                             │  Hono proxy             │
                             │  /v1/chat/completions   │
                             │  /v1/messages           │
                             │  /v1/messages/count_tokens
                             └───────────┬─────────────┘
                                         │  calls into
                                         ▼
                             ┌─────────────────────────┐
                             │  HatchClient            │
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

### 1. User-facing HTTP (`src/server/start.ts`)

Standard Hono + @hono/node-server. Two shape adapters:

- **OpenAI shape** — `POST /v1/chat/completions`. Flattens `messages[]` → one prompt. Returns either a single JSON `chat.completion` or an SSE stream of `chat.completion.chunk`s terminated by `data: [DONE]`.
- **Anthropic shape** — `POST /v1/messages`. Same flattening. Returns either a single `message` JSON or SSE events matching Anthropic's `message_start / content_block_* / message_delta / message_stop` sequence.
- **Also** `GET /v1/models`, `GET /healthz`, `POST /v1/messages/count_tokens` (stub).

Auth: optional `MUSE_PROXY_KEY` env var checked against `Authorization: Bearer <key>` or `x-api-key: <key>`. Unset → open server (dev only).

### 2. Hatch client (`src/hatch/client.ts`)

`HatchClient` opens one Noise WS per request. Methods:
- `request(verb, path, body?)` — fires one ApplicationRequest, returns the stream_id.
- `_recvOne()` — pulls one assembled frame (handles both `response`/`body_chunk` streams and self-contained JSON events on subscribe streams).
- `collectUntil(pred, deadlineMs)` — loop that keeps calling `_recvOne` until a predicate matches.

`sendAndCollectReply(userText, timezone, listenMs, sessionState?)` orchestrates the sequence:
1. `POST /api/nodes/register` with `node_id = sessionState.nodeId` (stable per API session). Required for side-chat event delivery.
2. `POST /client/register-capabilities` with the same `nodeId` as `client_id`.
3. `POST /chat/subscribe` — scoped (`session_id`) for side chats, global otherwise.
4. `POST /chat/stream` with the user text + `session_id` for side chats.
5. Collect `delta.text_append` events until `delta.message_done` / `message.assistant`.
6. **Side-chat fallback:** if no deltas arrived (first-message race), `GET /chat/history?session_id=X` and extract the assistant reply.

Payloads larger than 48KB are automatically split across multiple NoiseTransportFrame chunks (see `src/hatch/transport.ts`).

### 2a. Per-session routing (`src/hatch/sessions.ts`)

`SessionStore` maps API-session keys → `{sessionId, nodeId}` with 24h sliding TTL + LRU eviction. Session key derivation (`deriveSessionKey`):

- `X-Muse-Session: <value>` header → `h:<value>` → dedicated side chat on muse.
- else `Authorization: Bearer <token>` → `a:<sha256-16>` → dedicated per-API-key side chat.
- else → `default` → shared main chat (no `session_id` sent, backward compatible).

`sessionId` is a client-chosen UUID generated once per key; first `/chat/stream` with that id creates the side chat on muse, subsequent uses continue it.

### 3. Noise transport (`src/noise/`)

- WebSocket to `wss://hatch.metaaivm.com/v1/noise?vm_id=&auth_token=&notary_token=&app_id=hatch-web&request_id=`.
- 3-message Noise XX handshake (initiator) — hand-rolled on `@noble/curves` (X25519), `@noble/ciphers` (AES-GCM), `@noble/hashes` (SHA-256 HKDF).
- Each WS binary frame = one AES-GCM ciphertext of one `NoiseTransportFrame` protobuf.
- The WS upgrade uses Node 22 `globalThis.WebSocket`; TLS fingerprinting for HTTP calls uses `cycletls` (see §5 below).

### 4. Hatch VM (server-side)

Per-user VM at `<vm_id>.metaaivm.com`, fronted by the shared LB `hatch.metaaivm.com`. Runs a small internal HTTP router exposing JSON endpoints. The real agent (Muse Spark model + tools + memory) is behind the DAEMON service. SENTINEL/VAULT/AUTHD are support services only `/healthz`-reachable via noise.

### 5. Bootstrap chain (`src/bootstrap/`)

Before the Noise WS can open, we need four HTTP POSTs on `muse.ai` with the user's session cookies:

1. `/api/hatch/lease-vm` — assigns a VM (403 if one already assigned; fall back to scraping the HTML).
2. `/api/hatch/vm/wake` — wakes the specific VM.
3. `/api/hatch/token` — short-lived EdDSA JWT bound to the VM.
4. `/api/hatch/noise-notary-token` — server-side attestation of the VM's Noise key chain.

All four responses + a locally-generated request_id get combined into the final `wss://` URL.

HTTP calls use `cycletls` for HTTP; the WS upgrade itself uses Node's native `globalThis.WebSocket`.

## Concurrency model

Each incoming OpenAI/Anthropic request → one fresh Noise handshake → one send-and-collect round-trip. Handshake overhead ~500ms per request. Not pooled.

The Hono server is async-native. Hatch work runs inside an async flow with streaming deltas pushed through Node.js readable streams to the SSE generator.

## State

- **Persistent across runs:** `~/.ssh/*` (your git keys), `./storage_state.json` (your muse.ai cookies), `./session.json` (last-bootstrapped tokens).
- **Rebuilt per run:** everything else. Noise keys are per-handshake; stream_ids per-connection; the WS session itself is per-request.

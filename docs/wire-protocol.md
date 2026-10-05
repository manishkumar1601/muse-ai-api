# Wire protocol

Everything below is observed, not documented. Subject to change at Meta's whim.

## 1. Transport URL

```
wss://hatch.metaaivm.com/v1/noise
    ?vm_id=<uuid>
    &auth_token=<EdDSA JWT>
    &notary_token=endorsement.v1.<base64>.<base64>.<base64>.<base64>
    &app_id=hatch-web
    &request_id=<fresh uuid>
```

Constants from the client bundle (`recon/chunks/24vdgjhlw22uj.js`):
- `HATCH_SHARED_LB_HOST = "hatch.metaaivm.com"`
- `NOISE_WS_PATH = "/v1/noise"`
- `HATCH_APP_ID = "hatch-web"` (env `NEXT_PUBLIC_ABRA_APP_ID`)

## 2. Noise handshake

**Suite:** `Noise_XX_25519_AESGCM_SHA256` (from `recon/chunks/1w9duffuzanuc.js`, exact string).

**Primitives:**
- X25519 for Diffie-Hellman (browser uses libsodium; our implementation uses `@noble/curves`).
- AES-GCM via `@noble/ciphers` (`aes-gcm` with 12-byte IV: 4 zero bytes + 8-byte big-endian counter).
- SHA-256 HKDF via `@noble/hashes`.

**Pattern:** standard interactive XX (three messages: `-> e`, `<- e, ee, s, es`, `-> s, se`).

**Nonce format for AES-GCM:** 4 zero bytes + 8-byte **big-endian** counter. Matches Noise AES-GCM spec.

**Message sizes (observed):**
| | Direction | Plaintext payload | Wire total |
|---|---|---|---|
| msg1 | client → server | 34B (see below) | 66B |
| msg2 | server → client | 70B (attestation) | 166B |
| msg3 | client → server | 0B (empty) | 64B |

**msg1 payload** (the 34 bytes inside):
```
0a 20 <32 CSPRNG bytes>
```
Protobuf field 1 (wire type 2, length-delimited), length 32, 32 random bytes. These 32 bytes are a "client freshness nonce" the server will echo back inside the msg2 attestation chain. Generated via `randomBytes(32)` from Node's `crypto` module.

**msg3 payload** = empty bytes for standard VMs. Confidential VMs (we don't support those) require a signed RV challenge response here.

**After msg3:** `[csSend, csRecv] = hs.split()`. For an XX initiator, the first returned cipher is the client's send cipher, the second is the client's recv cipher. Implemented in `src/noise/handshake.ts`.

## 3. NoiseTransportFrame

Every WS binary frame = exactly one AES-GCM ciphertext of one `NoiseTransportFrame` protobuf.

Schema (`src/proto/schemas/noise_transport.proto.binpb`):
```protobuf
message NoiseTransportFrame {
  optional int64  chunk_id     = 1;
  optional uint32 chunk_index  = 2;
  optional uint32 total_chunks = 3;
  optional bytes  payload      = 4;
}
```

Semantics:
- `chunk_id` groups chunks that reassemble into one logical message. Client assigns; server echoes.
- Multi-chunk messages: send `chunk_index 0..total_chunks-1` with the same `chunk_id`.
- Our chunker splits at **48KB** (`MAX_CHUNK_PAYLOAD` in `src/hatch/transport.ts`). Server limit is 65535B per frame.
- Server-pushed events typically fit in one chunk (`total_chunks=1`).

## 4. ServiceRequest / ServiceResponse

Inside the NoiseTransportFrame.payload:

```protobuf
// Direction: client -> server
message ServiceRequest {
  ServiceType service = 1;   // enum: DAEMON=0, SENTINEL=1, VAULT=2, AUTHD=3
  bytes payload = 2;         // serialized ServiceFrame
}

// Direction: server -> client
message ServiceResponse {
  bytes payload = 1;         // serialized ServiceFrame
}

enum ServiceType {
  SERVICE_DAEMON = 0;        // the application plane; everything useful is here
  SERVICE_SENTINEL = 1;      // only /healthz over noise
  SERVICE_VAULT = 2;         // only /healthz over noise
  SERVICE_AUTHD = 3;         // only /healthz over noise
}
```

For the DAEMON case, the `service` field is `0` (default), so a well-formed ServiceRequest actually omits field 1 entirely and starts with field 2 (`0x12`).

## 5. ServiceFrame — the HTTP-over-Noise envelope

Inside ServiceRequest.payload (or ServiceResponse.payload):

```protobuf
message ServiceFrame {
  int64 stream_id = 1;        // client-assigned, monotonic per Noise connection
  oneof kind {
    ApplicationRequest  request    = 2;
    ApplicationResponse response   = 3;
    BodyChunk           body_chunk = 4;
    Reset               reset      = 5;
  }
}

message ApplicationRequest  { string verb; string path; repeated Header headers; bytes body; bool end_body; }
message ApplicationResponse { int32 status; repeated Header headers; bytes body; bool end_body; }
message BodyChunk           { bytes data; bool end_body; }
message Header              { string key; string value; }

message Reset {
  enum Code { CODE_UNSPECIFIED=0; CANCELLED=1; TIMEOUT=2; PROTOCOL_ERROR=3;
              REFUSED_STREAM=4; INTERNAL_ERROR=5; SERVICE_UNAVAILABLE=6; }
  Code code = 1;
  string reason = 2;
}
```

**Stream semantics:**
- One-shot HTTP request/response: client sends ServiceFrame with `request:...`, server replies with 0..N `response` / `body_chunk` frames on the same stream_id, final one has `end_body: true`.
- Long-lived subscription (e.g. `/chat/subscribe`): server opens a `response` frame then keeps writing `body_chunk` frames on the same stream_id **forever**. `end_body` is never set. Each `body_chunk.data` is a complete self-contained JSON event.

## 6. Event JSON shape (subscribe streams)

Every event on `/chat/subscribe` is one JSON object:

```json
{
  "event": "<name>",
  "payload": { ... event-specific ... },
  "ts_ms": 1790923846160,
  "seq": 150,
  "type": "event"
}
```

Observed event names so far:
- `message.user` — echo of a user-sent message
- `agent.status` — `{activity_code: "working" | "responding" | "online", activity_text: "..."}`
- `reactions.updated` — emoji reactions on messages
- `delta.message_start` — assistant message begins
- `delta.text_append` — one chunk of streamed assistant text (field: `payload.text` or `payload.delta`)
- `delta.message_done` — assistant message complete; full text available in `payload.transcript.messages[*].content[*].text`
- `delta.presentation` — assistant pushes a widget/card (not surfaced by our proxy yet)
- `widget.state_updated` — widget state change
- `task.status` — background task progress
- `approvals.snapshot` — pending approvals
- `chat.seen` — read receipt

## 7. Catch-up vs live

`POST /chat/subscribe` body:
```json
{"after_stream_seq": 0, "after_chat_event_seq": 0, "capabilities": [...]}
```

Server replays every event after `after_chat_event_seq`. Pass `0` → everything replays. In our client we filter by `ts_ms < send_start_ms` to drop replays and keep only live events for our request.

## 8. Side chats (threads)

A side chat is a separate conversation visible under the "Side chats" header in the muse sidebar. The protocol identifies it by a client-chosen UUID in the `/chat/stream` body:

```json
{"message": "...", "node_id": "<uuid>", "capabilities": [...],
 "session_id": "<thread uuid, client-chosen>",
 "timezone": "...", "metadata": {"thread_is_dictation_used": false}}
```

- **First call** with a fresh `session_id` → muse creates a new side chat under that UUID.
- **Subsequent calls** with the same `session_id` → appended to that thread.
- **Omit `session_id`** → goes to main chat.

Three things must line up for the assistant reply to reach a non-browser client (we learned this the hard way; see `memory/05-10-2026-side-chat-routing.md`):

1. **Register the node** — `POST /api/nodes/register` with your `node_id` BEFORE sending. Muse routes thread events only to registered nodes.
2. **Reuse `node_id` across all calls for the same API session** — `register-capabilities.client_id`, `/chat/stream.node_id`, `/api/nodes/register.node_id` all the same UUID. Events route back to that identity.
3. **Scope the subscribe** — `POST /chat/subscribe` with `session_id: <thread>` in body and `after_chat_event_seq: 0` so the server replays prior events (first-message reply may already have fired before the subscribe attached).

**Fallback for first-message race:** poll `GET /chat/history?limit=40&transcript_mode=messages&session_id=X` and pick the first `message.assistant` entry after your sent `message_id`. Deltas can be lost between thread creation and subscribe attach; the history poll always sees the stored reply.

## 9. Why `/client/register-capabilities` is required

Without a prior `POST /client/register-capabilities` with a `client_id`, the server routes server-pushed events to whichever registered `client_id` it saw last (likely your open browser tab). To receive events on OUR connection, we must register our own `client_id` AND use the same UUID as `node_id` in the `/chat/stream` POST.

Shape:
```json
{
  "client_id": "<fresh uuid>",
  "platform": "web",
  "display_name": "muse-proxy",
  "version": "0.0.0",
  "capabilities": {
    "data_sources": {},
    "device_commands": {},
    "hatch_app_commands": {},
    "rendering": { "supported_presentations": [...], ... }
  }
}
```

Our proxy sends a minimal `rendering.supported_presentations` list; add more if you want to receive widgets.

# Phase 3 — HTTP-over-Noise route discovery (02-10-2026)

## Goal

Decode the extracted FileDescriptorProtos, build real `ServiceFrame.ApplicationRequest` messages, and discover what HTTP routes the Hatch VM exposes.

## What I tried

1. **Decoded `noise_envelope.proto`** with `google.protobuf.descriptor_pb2.FileDescriptorProto.ParseFromString()` then rendered as `.proto` source. **This was the biggest reveal of the whole project** — the transport is literal HTTP semantics in protobuf:
   ```
   ServiceFrame { stream_id, oneof { request, response, body_chunk, reset } }
   ApplicationRequest  { string verb; string path; repeated Header headers; bytes body; bool end_body; }
   ApplicationResponse { int32 status; repeated Header headers; bytes body; bool end_body; }
   ```
   The "application-level protobuf" I thought we'd need to reverse (ChatMessage, GatewayRequest, etc.) turned out to be JSON bodies inside those ApplicationRequest/Response envelopes. Phase 2's "need to AST-extract bufbuild-es" worry evaporated.
2. **Built dynamic protobuf messages at runtime** using `DescriptorPool` + `message_factory.GetMessageClass`. No `protoc` codegen needed.
3. **First probe: `GET /` on SERVICE_DAEMON** — Git Bash expanded `/` to `C:/Program Files/Git/`. Server returned `{"error":"invalid path"}`. **Our pipeline was working** — just the shell was mangling. Switched to PowerShell for probes.
4. **Sweep of 48 probes** across 4 services × common paths. Discovered:
   - `GET /healthz` → 200 (DAEMON, SENTINEL, AUTHD)
   - `GET /health` → 200 (75KB VM state blob)
   - `GET /version` → 200
   - `GET /feed`, `/ideas`, `/goals`, `/connectors` → 200
   - `POST /chat/send` → 400 "must provide `message` or non-empty `items`" — chat endpoint!
   - Everything else: 404 "route not found" or 403 "path not allowed via noise"
5. **Guided-error-message iteration on `/chat/send`:**
   ```
   {}                                     → "must provide `message` or non-empty `items`"
   {message:"hi"}                         → "chat.send over the local HTTP API requires `kind=action`"
   {kind:"action", message:"hi"}          → "`space_slug` is required when `kind=action`"
   {kind,space_slug:"default",message}    → "`action` is required when `kind=action`"
   {kind,space_slug,action:"send",...}    → "`invocation_id` is required when `kind=action`"
   {...with invocation_id:uuid, message}  → 200 OK + {reply_to_message_id}
   ```
   Server literally spells out what's missing on each 400. Fastest route discovery I've ever done.

## What worked

- `DescriptorPool` + `message_factory.GetMessageClass` for dynamic schema loading at runtime (no protoc).
- `sweep.py` opens ONE Noise channel, fires N probes on distinct stream_ids, correlates responses + body_chunks by stream_id, auto-exits when all streams have ended.
- Setting `ws.curl.setopt(TIMEOUT_MS, 2000)` so `recv()` doesn't block forever after the server drains.
- `/chat/send` with `kind=action` returned 200 with a `reply_to_message_id` — but the message does NOT surface in the chat UI (verified via Playwright). Phase 4 found why.

## Gotchas (worth remembering)

1. **Verb matters per path.** `GET /chat/stream` returns 403 "matched route missing from endpoint ACL"; `POST /chat/stream` works (Phase 4). The ACL is per-verb-per-path.
2. **Only 4 ServiceTypes exist** (DAEMON/SENTINEL/VAULT/AUTHD). SENTINEL/VAULT/AUTHD only expose `/healthz` over noise; everything else returns `path not allowed via noise`. Don't waste probe budget on them.
3. **Response envelope is always** `{"ok":bool, "result": ..., "error":{code, message}}`.
4. **Reassemble body_chunks by stream_id**, not by chunk_id. chunk_id groups the NoiseTransportFrame chunks of one message; stream_id groups frames of the same HTTP request/response pair.
5. **curl_cffi `recv()` blocks indefinitely without a per-op timeout.** Must call `ws.curl.setopt(TIMEOUT_MS, 2000)` after `ws_connect`.
6. **MSYS/Git Bash expands bare `/`** on the command line. For probes with path arguments, use PowerShell or quote carefully.

## Discovered live DAEMON routes

| Verb | Path | Status | Notes |
|---|---|---|---|
| GET | /healthz | 200 | git_sha + build info |
| GET | /health | 200 | **~75KB** of live VM state (counters, workers, etc.) |
| GET | /version | 200 | `hatch 0.1.0 (fa593de972c)` |
| GET | /feed | 200 | daily feed prompts |
| GET | /ideas | 200 | idea packs |
| GET | /goals | 200 | pagination envelope |
| GET | /connectors | 200 | **~82KB** listing of 150+ app integrations |
| POST | /chat/send | 200 (with kind=action) | agent action trigger |
| GET | /chat/stream | 403 | verb check — Phase 4 showed POST works |

Everything else: 404 `not_found`.

## Deliverables

`phase3/`:
- `decode_descriptors.py` — renders `.binpb` → `.proto` source
- `probe.py` — single-shot probe
- `sweep.py` — batch probe + body assembly
- `sweep_out/<ts>/` — per-sweep results (gitignored)
- `README.md`, `requirements.txt`

## Next

Phase 4: `kind=user` is server-side-rejected over noise. The human-chat path is different. Instrument the browser to find it.

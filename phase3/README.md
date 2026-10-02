# Phase 3 — speak HTTP-over-Noise to the Hatch VM

Builds dynamic protobuf messages from the descriptors Phase 2 extracted, encodes real `ServiceFrame`s carrying `ApplicationRequest`s, sends them over the Noise channel, and parses the replies. Enumerates the live DAEMON/SENTINEL/VAULT/AUTHD HTTP route surface on the VM.

**Status: full round-trip proven.** `POST /chat/send` returns `200 OK` with `reply_to_message_id`. A short JSON exchange with the Hatch agent is now possible from Python.

## Install

```
pip install -r requirements.txt
```

Adds the stdlib `protobuf` wheel on top of Phase 2's deps for dynamic descriptor loading.

## Scripts

```
decode_descriptors.py  — renders ../phase2/protos/*.binpb as readable .proto source
probe.py               — single-shot: one ServiceFrame → record replies
sweep.py               — one Noise channel, batch many probes (any svc/verb/path),
                         reassemble body chunks, early-exit when all streams end
```

## Run

```bash
# Human-readable schemas → ./schemas/
python decode_descriptors.py

# Default sweep (probes DAEMON/SENTINEL/VAULT/AUTHD on common paths)
python sweep.py --listen-seconds 15

# Custom probe list (PowerShell quoting shown):
#   [ [svc, verb, path, body_json_or_null], ... ]
python sweep.py --probes probes.json
```

## What Phase 3 proved — the full stack is tractable

### The transport (`noise_envelope.proto`, decoded)

```
enum ServiceType { SERVICE_DAEMON=0; SERVICE_SENTINEL=1; SERVICE_VAULT=2; SERVICE_AUTHD=3; }

message ServiceRequest  { ServiceType service=1; bytes payload=2; }
message ServiceResponse { bytes payload=1; }

message ServiceFrame {
  int64 stream_id = 1;
  oneof kind {
    ApplicationRequest  request  = 2;
    ApplicationResponse response = 3;
    BodyChunk           body_chunk = 4;
    Reset               reset = 5;
  }
}

message ApplicationRequest  { string verb; string path; repeated Header headers; bytes body; bool end_body; }
message ApplicationResponse { int32 status; repeated Header headers; bytes body; bool end_body; }
message BodyChunk           { bytes data; bool end_body; }
message Reset               { Code code; string reason; }   // CANCELLED/TIMEOUT/PROTOCOL_ERROR/REFUSED_STREAM/INTERNAL_ERROR/SERVICE_UNAVAILABLE
```

Framing per WS binary frame:
```
NoiseTransportFrame { chunk_id, chunk_index, total_chunks, payload }
  payload = ServiceRequest{service, payload: ServiceFrame bytes}      (client -> server)
  payload = ServiceResponse{payload: ServiceFrame bytes}              (server -> client)
```

**HTTP-over-Noise. Response bodies arrive as a `response` frame then one or more `body_chunk` frames, matched by `stream_id`.**

### Discovered live DAEMON routes

From one 48-probe sweep against a fresh VM:

| Path | Status | Body preview |
|---|---|---|
| `GET /healthz` | 200 | `{"all_healthy":"HEALTHY","build":{"git_sha":"fa593de972c"}}` |
| `GET /health` | 200 | **75 KB** of live counters (active_delivery_count, active_runtime_work_count, active_scheduled_run_count, active_subagent_count, ...) |
| `GET /version` | 200 | `hatch 0.1.0 (fa593de972c)` with full build info |
| `GET /feed` | 200 | 18 KB of daily feed prompts |
| `GET /ideas` | 200 | 2 KB of idea packs |
| `GET /goals` | 200 | pagination envelope |
| `GET /connectors` | 200 | **82 KB** listing 150+ app connectors (asana, slack, gmail, ...) |
| `GET /chat/stream` | 403 | `matched route missing from endpoint ACL` |
| `POST /chat/send` | 200/400 | agent chat endpoint — see below |

Everything else returned a JSON `{"ok":false,"error":{"code":"not_found","message":"route not found"}}`. SENTINEL and AUTHD only expose `/healthz` over noise; all other paths get `path not allowed via noise`.

### The chat endpoint — accepted request shape

```json
POST /chat/send   (service: DAEMON)
Content-Type: application/json
{
  "kind":          "action",             // "user" is server-side rejected over noise
  "space_slug":    "default",            // chat context slug
  "action":        "send",               // string, not an object
  "invocation_id": "<fresh uuid>",
  "message":       "hello"
}
```

Server returns:
```json
{"ok":true,"result":{"channel":"main","reply_to_message_id":"<uuid>","response":""}}
```

The server accepts and processes the message (allocates a `reply_to_message_id`), but the actual assistant reply streams asynchronously via a push channel we did not nail down in this phase. `GET /chat/stream` 403s over noise — the human-facing chat loop lives behind a tighter ACL than `/chat/send` with `kind=action`.

### Known constraints uncovered

- `kind=user` is explicitly blocked: `"chat.send over the local HTTP API requires kind=action"`. The pipeline distinguishes automated-action messages (callable via noise) from human-user messages (not callable here). A different code path, likely a WebSocket or push subscription keyed off `/chat/stream`, delivers human-visible messages.
- All responses carry an envelope: `{"ok":bool, "result": ..., "error":{code,message}}`.
- Only 4 service types exist: `DAEMON` is the application plane, `SENTINEL`/`VAULT`/`AUTHD` only expose `/healthz` over noise.

### Protobuf schema coverage

Only 5 of the ~12 bundled schemas are extractable via `fileDesc("<base64>")`:
`noise_transport.proto`, `noise_envelope.proto`, `attestation_bundle.proto`, `plexi_types.proto`, `revocation_list.proto`.

The application-level messages (`ChatMessage`, `GatewayRequest`, etc. seen as string references in the client bundle) turn out to be a non-issue — the DAEMON HTTP API uses **JSON bodies** inside the ApplicationRequest/Response, not protobuf. So Phase 2's "need to AST-extract bufbuild-es schemas" worry evaporates for anything reachable from a Noise client.

## Files

```
decode_descriptors.py  — descriptor renderer (120 lines)
probe.py               — single-request probe (170 lines)
sweep.py               — batch probe + response assembler (160 lines)
requirements.txt       — curl_cffi, dissononce, protobuf
.gitignore             — sweep_out/, frames/, schemas/, probes.json, chat_out.log
schemas/               — one .proto file per descriptor (gitignored output)
sweep_out/             — timestamped JSON results per run (gitignored)
```

## Known limits / next

- No streaming assistant reply yet. `kind=user` is the gate; finding the push subscription endpoint (likely `/chat/stream` with specific headers or `/chat/subscribe` on a non-DAEMON service) is Phase 4 work.
- No reconnect / token refresh. If `../phase1/session.json` is stale, probes just get `401` on WS upgrade — rerun phase1.
- Only `self-check` style tests. Probing is inherently network-dependent; the artifacts in `sweep_out/<ts>/results.json` are the verification record.
- Nothing is parallelized across multiple VMs or users; everything runs against the single VM in `session.json`.

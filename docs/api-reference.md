# API reference — discovered Hatch VM endpoints

All of these are HTTP-over-Noise calls to `SERVICE_DAEMON` unless noted. Reach them from Python via:

```python
from phase4.chat import HatchClient
client = HatchClient()
sid = client.request("GET", "/healthz")   # or "POST", "/path", body={...}
# consume with client._recv_one() / client.collect_until(pred, deadline_s)
```

Everything returns a JSON envelope: `{"ok": bool, "result": ..., "error": {"code", "message"}}`. Non-200 statuses also return this envelope with `ok=false`.

---

## Public muse.ai endpoints (NOT noise — plain HTTPS with cookies)

Used by `phase1/bootstrap.py` to produce `session.json`.

### `POST /api/hatch/lease-vm`
```json
request:  {"vmType": "standard"}
response: {"status": "assigned", "gatewayUrl": "wss://<vm>.metaaivm.com/", "vmName": "<vm_id>"}
```
Fails 403 once the account has a VM already assigned. Fall back to parsing `activeGatewayUrl` from `GET /` HTML.

### `POST /api/hatch/vm/wake`
```json
request:  {"vm_id": "<uuid>", "retry_count": 0}
response: {"status": "wake_requested"}
```

### `POST /api/hatch/token`
```json
request:  {"vmAddress": "wss://<vm>.metaaivm.com/", "vmName": "<uuid>"}
response: {"token": "s0.eyJ...<EdDSA JWT>", "notary_token": "endorsement.v1....."}
```
JWT `kid=HATCH_EDGE_TO_VM_ADMISSION:1`. TTL ~a few hours.

### `POST /api/hatch/noise-notary-token`
```json
request:  {"vmName": "<uuid>"}
response: {"notaryToken": "endorsement.v1.<b64 payload>.<b64 sig>.<b64 uri>.<b64 sig2>"}
```
Note the camelCase in the response field name (vs snake_case `notary_token` from `/token` response).

---

## DAEMON — HTTP-over-Noise

### Health / meta

| Verb | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/healthz` | none | — | `{"all_healthy":"HEALTHY","build":{"git_sha":"..."}}` |
| GET | `/health` | — | — | ~75KB VM state (counters, workers, scheduled runs, subagents, delivery queue) |
| GET | `/version` | — | — | `hatch 0.1.0 (<sha>)` + full build info |
| GET | `/model` | — | — | current model identity (observed: Muse Spark) |

### Content / state

| Verb | Path | Response |
|---|---|---|
| GET | `/feed` | daily feed prompts (observed ~18KB, varies) |
| GET | `/feed?timezone=...` | tz-localized feed |
| GET | `/ideas` | `{"ideas":[{idea_id, kind, title, ...}]}` |
| GET | `/goals` | pagination envelope + list |
| GET | `/goals?source=user_goal` | user-created goals only |
| GET | `/goals?source=assistant_tracking` | assistant-tracked goals |
| GET | `/connectors` | 150+ app integration metadata (~82KB) |
| GET | `/identity` | user identity info |
| GET | `/approvals` | pending approvals |
| GET | `/shared-agents/capabilities` | shared agent capability catalogue |
| GET | `/spaces/v2` | user's spaces |
| GET | `/chat/history?limit=40&transcript_mode=messages` | recent messages |

### Subscriptions (long-lived push streams)

Each of these opens a stream the server keeps writing JSON events to. Body is small — see `docs/wire-protocol.md` section 6 for event shapes.

| Verb | Path | Notes |
|---|---|---|
| POST | `/chat/subscribe` | **the main chat event stream** |
| POST | `/navigation/subscribe` | nav bar updates |
| POST | `/identity/subscribe` | identity change notifications |
| POST | `/themes/subscribe` | theme changes |
| POST | `/spaces/subscribe` | spaces changes |
| POST | `/artifacts/subscribe` | artifact uploads/edits |
| POST | `/fs/subscribe` | file-system events |

### Chat

| Verb | Path | Body (JSON) | Notes |
|---|---|---|---|
| POST | `/chat/send` | `{kind:"action", space_slug, action, invocation_id, message}` | **not** human chat. For agent action invocations. `kind:"user"` is blocked here over noise. |
| POST | `/chat/stream` | `{message, node_id, capabilities, timezone}` | **the human chat endpoint.** See below. |
| POST | `/api/chat/main/seen` | — | mark messages read |
| GET  | `/api/chat/themes` | — | theme list |

### `/chat/stream` request body (what the browser actually sends)

```json
{
  "message":      "<user text>",
  "node_id":      "<uuid — same as client_id passed to register-capabilities>",
  "capabilities": ["chat_cancel", "delta_stream", "custom_reactions", "custom_reactions_facebook_thumbs_up_v1"],
  "timezone":     "<IANA tz, e.g. Asia/Calcutta>"
}
```

Sync ack response:
```json
{"channel":"main", "is_thread":false,
 "message_id":"<uuid>", "reply_to_message_id":"<uuid>",
 "session_id":"<chat session uuid>"}
```

The actual assistant reply arrives as a stream of events on the `/chat/subscribe` stream (not on this request's stream_id). See `docs/request-flow.md`.

### Client lifecycle

| Verb | Path | Body | Notes |
|---|---|---|---|
| POST | `/client/register-capabilities` | `{client_id, platform, display_name, version, capabilities:{...}}` | **required before `/chat/subscribe`** to receive pushed events |
| POST | `/api/nodes/register` | — | node registration (we don't call this; browser does) |
| POST | `/api/ping` | — | keepalive (observed, not required for us) |
| POST | `/api/fs/subscribe` | `{}` | |
| POST | `/onboarding/pages` | — | |
| POST | `/navigation/recents/touch` | — | update recent-items list |

### File system (seen in browser traffic, not probed from our client)

| Verb | Path | |
|---|---|---|
| POST | `/fs/library` | library file list |
| POST | `/api/artifacts/subscribe` | artifact push stream |

---

## Not reachable over noise (observed)

| Verb | Path | Error |
|---|---|---|
| GET | `/chat/stream` | 403 `matched route missing from endpoint ACL` (POST works) |
| GET | `/debug`, `/_debug`, `/routes`, `/_routes`, `/metrics` | 404 `route not found` |
| GET | `/openapi.json`, `/.well-known/openid-configuration` | 404 |
| GET | `/graphql`, `/v1/graphql`, `/query`, `/rpc` | 404 (no GraphQL surface over noise) |

---

## Non-DAEMON services

Only `/healthz` is reachable over noise. Everything else returns 403 `path not allowed via noise`.

| Service | Path | Status |
|---|---|---|
| SENTINEL | `/healthz` | 200 `{"ok":true,"result":{"status":"ok"}}` |
| AUTHD    | `/healthz` | 200 `ok` (plain text) |
| VAULT    | `/healthz` | 200 |

---

## Re-probing

To check if routes have changed:
```bash
python phase3/sweep.py --listen-seconds 15
cat phase3/sweep_out/<ts>/results.json
```

To probe a specific endpoint:
```bash
# PowerShell quoting of embedded JSON:
Set-Content -Path probes.json -Value '[["DAEMON","GET","/your-path",null]]' -Encoding ascii
python phase3/sweep.py --probes probes.json --listen-seconds 10
```

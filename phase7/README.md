# Phase 7 — OpenAI + Anthropic compatible proxy for muse.ai

One tiny FastAPI server that speaks both the OpenAI `/v1/chat/completions` and the Anthropic `/v1/messages` wire formats, routes every request through the reverse-engineered Noise stack (Phases 1–5), and returns the Muse personal agent's reply.

**Four modes, all working:** OpenAI non-stream, OpenAI SSE stream, Anthropic non-stream, Anthropic SSE stream.

## Install + run

```
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8787
```

Optional env:

| Var | Default | What |
|---|---|---|
| `MUSE_PROXY_KEY` | *(unset)* | require `Authorization: Bearer <key>` or `x-api-key: <key>`. Unset → open server (localhost dev). |
| `MUSE_PROXY_MODEL` | `muse-spark` | model name advertised in `/v1/models` and echoed in responses |
| `MUSE_SESSION_PATH` | `../phase1/session.json` | Phase 1 output. If stale, server will try one auto-rebootstrap. |
| `MUSE_TZ` | `Asia/Calcutta` | timezone sent to Hatch (affects agent context) |

## Endpoints

```
POST /v1/chat/completions   OpenAI shape, stream + non-stream
POST /v1/messages           Anthropic shape, stream + non-stream
GET  /v1/models             OpenAI model list (one entry)
GET  /healthz               liveness
```

## Use it

### From the OpenAI Python SDK
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")
r = client.chat.completions.create(
    model="muse-spark",
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)
```

### From the Anthropic Python SDK
```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:8787", api_key="anything")
r = client.messages.create(
    model="muse-spark",
    max_tokens=200,
    messages=[{"role": "user", "content": "hi"}],
)
print(r.content[0].text)
```

### From Claude Code
Point it at the Anthropic surface by exporting:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN = "anything"
$env:ANTHROPIC_MODEL = "muse-spark"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "muse-spark"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "muse-spark"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "muse-spark"
$env:CLAUDE_CODE_SUBAGENT_MODEL = "muse-spark"
claude "say hi"
```

### Verified round-trips (what Phase 7 was tested with)

```
POST /v1/chat/completions  non-stream
  -> {"content":"phase7-openai-ok", ...}
POST /v1/chat/completions  stream
  -> data: {"delta":{"role":"assistant",...}}
     data: {"delta":{"content":"1 2 3 4 5"}}
     data: {"delta":{},"finish_reason":"stop"}
     data: [DONE]
POST /v1/messages          non-stream
  -> {"content":[{"type":"text","text":"phase7-anthropic-ok"}], ...}
POST /v1/messages          stream
  -> event: message_start
     event: content_block_start
     event: content_block_delta  (chunks of text)
     event: content_block_stop
     event: message_delta
     event: message_stop
```

## How it works

1. Request hits one of the two shape adapters.
2. We flatten the `messages` list into a single prompt string (role-prefixed for context).
3. One fresh Noise handshake per request (per Phase 2), then the Phase 4+5 sequence:
   `/client/register-capabilities` → `/chat/subscribe` → `POST /chat/stream` with the user text.
4. We stream the agent's reply out of the subscribe stream (events filtered by timestamp so catch-up state doesn't bleed in).
5. For non-stream requests we collect all `delta.text_append` deltas and return once we see `delta.message_done`.
6. For stream requests we re-emit each delta in the client's native SSE wire format on the fly.

Each request opens a fresh Noise session — ~500 ms handshake overhead per request. Good enough for a proxy; a production version would pool sessions.

## Known limits — the lazy ladder bits we didn't climb

- Only text out. The Hatch agent can push images, widgets, etc. — those arrive as `delta.presentation` events and are dropped on the floor by this proxy. Add later if a caller cares.
- Multi-turn context: every proxy call opens a fresh Hatch session and sends your flattened `messages` as one user turn. The server-side agent sees it as a single prompt, not a conversation. For a real multi-turn feel the agent still has its own memory via your Meta account; it just doesn't know about per-request OpenAI/Anthropic message history separately.
- `usage` counts are faked (zeros). Hatch doesn't surface token counts; we'd have to tokenize client-side.
- No cancellation. If a client disconnects mid-stream, the Hatch request keeps running server-side until completion. Lazy; fix if it matters.
- No connection pooling. One Noise handshake per request. Add pooling if latency hurts under load.
- `MUSE_PROXY_KEY` is the only auth. If you expose this beyond localhost, use HTTPS and set the key.

## Files

```
server.py          — the whole thing (~250 lines FastAPI)
requirements.txt   — fastapi, uvicorn, curl_cffi, dissononce, protobuf
.gitignore
README.md
```

## Fits-on-a-napkin recap of all seven phases

```
phase 0  recon           — grep Hatch JS, confirm Noise XX + VM protocol
phase 1  bootstrap.py    — cookies + 4 HTTP calls → session.json with ws_url
phase 2  handshake.py    — Noise XX handshake, record ciphertext/plaintext
phase 3  sweep.py        — HTTP-over-Noise route discovery → ~15 live endpoints
phase 4  chat.py         — POST /chat/stream to send human messages
phase 5  chat.py + /chat/subscribe + /client/register-capabilities
                        → collect streamed assistant reply end-to-end
phase 6  (merged into phase 7 — auto-rebootstrap on first failure)
phase 7  server.py      — OpenAI + Anthropic compatible proxy, both stream + non-stream
```

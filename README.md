# muse-ai-api

Reverse-engineered Python client + OpenAI/Anthropic-compatible proxy for Meta's **muse.ai** (Hatch) personal agent.

Lets you call the Muse Spark model (and the agent behind it) from any OpenAI or Anthropic SDK by pointing it at a local proxy.

## ⚠️ Status, scope, and legal

- **Research / interop demo, not a product.** Everything here was figured out by observing the browser from the outside: no insider info, no Meta source. It is _fragile_ by construction — Meta ships hatch-web updates frequently and any of them can break any phase.
- **Uses your own Meta login.** You authenticate to muse.ai in a browser as yourself, dump the session cookies, and the Python code impersonates _your_ browser. The server sees your real account the whole time.
- **No bypass of pay/auth.** Anything the muse.ai web UI lets you do, this lets you script. Anything behind an ACL (e.g. certain `/chat/stream` ACLs) still returns 403 for us too.
- **Meta's ToS and your local law apply.** Reverse-engineering of client protocols sits in a gray area in most jurisdictions. If your use case needs legal certainty, use Meta's official [Model API](https://dev.meta.ai/) — same underlying model, documented, supported, and OpenAI-compatible out of the box. This repo is for people who want the _agent_, not just the _model_.
- **Expect takedowns / updates.** If you fork or redistribute, understand you may be subject to DMCA or similar notices.

## What's in here

```
README.md             you are here
docs/                 reference — architecture, wire protocol, API, compat, troubleshooting
memory/               dated session logs — the "why" behind every design decision
recon/                phase 0 — JS chunks, grep catalogs, decoded protobuf descriptors
phase1/   bootstrap.py       — cookies -> session.json with ws_url
phase2/   handshake.py       — Noise XX handshake + frame recorder
          extract_protos.py  — pull FileDescriptorProto blobs from the JS bundle
          protos/            — 5 extracted .binpb FileDescriptorProto files
phase3/   decode_descriptors.py + probe.py + sweep.py
                              — HTTP-over-Noise route discovery (~15 live DAEMON endpoints)
phase4/   chat.py            — send human chat message, assemble streamed reply
phase7/   server.py          — FastAPI proxy: OpenAI /v1/chat/completions + Anthropic /v1/messages
                                (stream + non-stream), auto-refresh session on failure
```

Each phase has its own README with runnable commands. For the big picture:

- **Just want to use it?** → [docs/phases-overview.md](docs/phases-overview.md) → [docs/anthropic-compat.md](docs/anthropic-compat.md) or [docs/openai-compat.md](docs/openai-compat.md).
- **Want to understand how it works?** → [docs/architecture.md](docs/architecture.md) → [docs/wire-protocol.md](docs/wire-protocol.md) → [docs/request-flow.md](docs/request-flow.md) → [docs/api-reference.md](docs/api-reference.md).
- **Want to extend it?** → [docs/development.md](docs/development.md) + the relevant [memory/](memory/) entry.
- **Something broken?** → [docs/troubleshooting.md](docs/troubleshooting.md).
- **Want the story of how this got built?** → [memory/README.md](memory/README.md) walks through all 7 phases chronologically.

## Quick start

```bash
# 1. authenticate once
#    Load https://muse.ai in Playwright or Chrome, log in with your Meta account.
#    Dump the cookie jar (Playwright example):
#      await page.context().storageState({ path: 'phase1/storage_state.json' })

# 2. bootstrap a Hatch session (produces phase1/session.json)
pip install -r phase1/requirements.txt
python phase1/bootstrap.py

# 3. quick end-to-end chat test from Python
pip install -r phase4/requirements.txt
python phase4/chat.py "say hi"

# 4. run the OpenAI/Anthropic-compatible proxy on 127.0.0.1:8787
pip install -r phase7/requirements.txt
python -m uvicorn phase7.server:app --app-dir phase7 --host 127.0.0.1 --port 8787

# 5. point any OpenAI / Anthropic client at it (env vars scoped to one subprocess)
#    OpenAI:
#      OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=anything  <your tool>
#    Anthropic (e.g. Claude Code):
#      ANTHROPIC_BASE_URL=http://127.0.0.1:8787  ANTHROPIC_AUTH_TOKEN=anything
#      ANTHROPIC_MODEL=muse-spark  ANTHROPIC_DEFAULT_OPUS_MODEL=muse-spark  (...SONNET...HAIKU...)
```

## What works today

- Noise `Noise_XX_25519_AESGCM_SHA256` handshake with Hatch.
- HTTP-over-Noise ServiceFrame transport, with per-request chunking across NoiseTransportFrames (~65 KB per frame limit).
- 15+ live DAEMON HTTP endpoints discovered: `/healthz`, `/health` (big VM state blob), `/version`, `/feed`, `/ideas`, `/goals`, `/connectors`, `/model`, `/identity`, `/approvals`, `/chat/history`, `/chat/subscribe`, `/chat/stream`, …
- Human-user chat: `POST /chat/stream` with proper subscribe+register preamble, streamed `delta.text_append` events reassembled into a final reply.
- OpenAI `/v1/chat/completions` (stream + non-stream) and Anthropic `/v1/messages` (stream + non-stream) wire formats.
- Automatic session re-bootstrap on first HatchClient open failure.

## Known limits

- Text only. The agent can push images / widgets / app cards (`delta.presentation` events). Those are logged but not surfaced to the OpenAI/Anthropic client.
- Multi-turn conversation threading is server-side only. The proxy flattens your `messages[]` into a single prompt per request.
- Faked token counts (zeros). Hatch does not expose a tokenizer.
- No cancel-on-disconnect. A dropped client doesn't abort the in-flight Hatch request.
- No connection pooling — one Noise handshake per proxy request (~500 ms).
- Only tested on Windows 11 + Python 3.12. Most things should work elsewhere.

## Non-obvious things I discovered the hard way

- Hatch 403s stock Python TLS/HTTP2 fingerprint on authenticated endpoints. Use `curl_cffi` with `impersonate="chrome"` and _also_ pin `User-Agent` + `sec-ch-ua*` headers to match the browser that minted the session cookie (session is UA-bound).
- `GET /chat/stream` → 403, `POST /chat/stream` → 200. ACL is per-verb-per-path.
- `kind: "action"` on `/chat/send` works over noise; `kind: "user"` is server-side-blocked. The human-user path is `/chat/stream`, not `/chat/send`.
- The subscribe stream is long-lived; each inbound `body_chunk` on it is one complete JSON event (`{event, payload, ts_ms, seq}`). `end_body` is never set on that stream.
- Need `POST /client/register-capabilities` BEFORE `POST /chat/subscribe` and use the same `client_id` as `node_id` in `/chat/stream`, otherwise server routes pushed events to another registered client (e.g. your open browser tab).
- When finding minified paths fails, monkey-patch `crypto.subtle.encrypt` via Playwright `page.addInitScript` and search the hex log for an ASCII marker you type into the real UI. It will give you the plaintext of every outgoing Noise frame.

## Credits

Nothing novel — the pieces (Noise, protobuf, FastAPI, dissononce, curl_cffi) are all off the shelf. The work was figuring out which pieces to glue together and in what order.

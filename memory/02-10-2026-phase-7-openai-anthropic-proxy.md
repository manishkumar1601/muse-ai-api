# Phase 7 — OpenAI + Anthropic compatible proxy (02-10-2026)

## Goal

Wrap the Phase 5 Hatch chat client in a FastAPI server that speaks both the OpenAI `/v1/chat/completions` and Anthropic `/v1/messages` wire formats, so any existing SDK can use muse.ai transparently.

## What I tried

1. **Picked FastAPI + uvicorn** — standard, async-friendly, built-in SSE support via `StreamingResponse`.
2. **Imported `HatchClient` from `../phase4/chat.py`** by adding `sys.path.insert` — avoids duplicating the Noise/subscribe code.
3. **Flattened incoming `messages[]` into one prompt string** with role prefixes (`[system]`, `[assistant previous turn]`, bare for user). The Hatch agent sees it as one user turn; multi-turn threading from the OpenAI/Anthropic side is lost but the agent has its own server-side memory.
4. **Non-stream endpoints** — just await the full reply, return a shaped response:
   - OpenAI: `{id, object:"chat.completion", choices:[{message:{role,content},finish_reason:"stop"}], usage:{0,0,0}}`
   - Anthropic: `{id, type:"message", role:"assistant", content:[{type:"text",text}], stop_reason:"end_turn", usage:{0,0}}`
5. **Streaming endpoints** — use `asyncio.Queue` as a bridge from the Hatch thread (which calls `stream_cb(text_delta)`) to the FastAPI SSE generator. Format differs by API:
   - OpenAI: `data: {chunk json}\n\n`, then `data: [DONE]\n\n`
   - Anthropic: `event: message_start\ndata: {...}\n\n` then `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
6. **First Claude Code integration test failed** — server returned 500 with `BoringSSL CLOSE_NOTIFY` during the Hatch recv. Direct Python test to the same proxy worked fine. The difference: Claude Code sends a large system prompt + tools + context → the ServiceRequest payload exceeded Hatch's ~65KB per-NoiseTransportFrame limit.
7. **Added payload chunking in `chat.py`'s `request()` method** — split large ServiceRequest bytes across multiple NoiseTransportFrame chunks (chunk_id groups them, chunk_index sequences them). After this fix, Claude Code round-trip succeeded.
8. **Also added `POST /v1/messages/count_tokens` stub** — Claude Code probes this before every message; without it the client hangs or 404s. We return `max(1, chars//4)` as a crude estimate.
9. **Request logging middleware** — logs `[req ] METHOD PATH` and `[resp] METHOD PATH STATUS (Nms)` for every request. Was essential for debugging the Claude Code integration.

## What worked

Four modes, all verified end-to-end:

```
POST /v1/chat/completions   non-stream  → "phase7-openai-ok"
POST /v1/chat/completions   stream      → "1 2 3 4 5"
POST /v1/messages           non-stream  → "phase7-anthropic-ok"
POST /v1/messages           stream      → "anthropic-stream-ok"
```

Claude Code integration (final test):
```
"" | claude -p "say exactly: muse-proxy-via-claude-ok"
→ muse-proxy-via-claude-ok
```

## Gotchas (worth remembering)

1. **Claude Code probes `/v1/messages/count_tokens`** before sending. If you return 404 it hangs. Any reasonable 200 response unblocks it.
2. **Claude Code's system prompt + tools context easily exceeds 65KB.** Must chunk ServiceRequest payloads across multiple NoiseTransportFrame chunks. Server-side reassembly happens via `chunk_id` grouping.
3. **Server does NOT exceed ~65KB per NoiseTransportFrame.** `maxMessageBytes: 65535` in the client bundle. Our chunker uses 48KB to leave headroom.
4. **Env vars for Claude Code redirect** (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) scope to the subprocess only. They do NOT modify `~/.claude/settings.json` or `~/.claude/.credentials.json`. Verified by comparing file timestamps before/after.
5. **PowerShell doesn't support `< $null` for stdin.** Use `"" | claude -p "..."` to pipe empty stdin.
6. **Each proxy request opens a fresh Noise handshake** (~500ms). Fine for POC, add pooling for production.
7. **Auto re-bootstrap on first failure** — if `HatchClient()` throws, call `_refresh_session()` (which reruns `phase1/bootstrap.py`) and retry once. Covers the common case where `session.json` expired overnight.

## Deliverables

`phase7/`:
- `server.py` — FastAPI app, ~290 lines, both OpenAI and Anthropic endpoints, stream + non-stream, auto re-bootstrap, request logging
- `requirements.txt` — fastapi, uvicorn, curl_cffi, dissononce, protobuf
- `.gitignore`, `README.md`

## Next (deliberately skipped)

- Multi-turn threading (currently flattened to one prompt per request)
- Real token counts (currently zeros)
- Cancel-on-disconnect
- Noise connection pooling
- Image / widget / presentation event surfacing to the OpenAI/Anthropic clients
- Phase 6 as a standalone phase — merged into Phase 7 as the auto-rebootstrap helper

# Anthropic compat — using the proxy with Anthropic tools (including Claude Code)

## Endpoint summary

```
POST  /v1/messages                stream + non-stream
POST  /v1/messages/count_tokens   returns a crude chars/4 estimate
```

Auth: `x-api-key: <anything>` or `Authorization: Bearer <anything>` if `MUSE_PROXY_KEY` is unset.

**Side-chat routing (optional):** pass `X-Muse-Session: <any-string>` to route the request to a dedicated side chat on muse.ai. Two requests with the same value share one side chat; different values get separate side chats. Omit → main chat. If no header is set, the proxy derives a session key from the `Authorization` bearer token (or `x-api-key`) so distinct API keys get distinct side chats automatically.

## Claude Code — the main use case

**Important:** set the env vars in the shell where you run `claude`, not globally. They do not touch `~/.claude/settings.json` or `~/.claude/.credentials.json`. Close the shell → `claude` goes back to your real Anthropic account.

### PowerShell
```powershell
$env:ANTHROPIC_BASE_URL             = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN           = "anything"
$env:ANTHROPIC_MODEL                = "muse-spark"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = "muse-spark"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "muse-spark"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = "muse-spark"
$env:CLAUDE_CODE_SUBAGENT_MODEL     = "muse-spark"
$env:ENABLE_TOOL_SEARCH             = "true"

# One-shot
"" | claude -p "your prompt here"

# Interactive session
claude
```

### Bash
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=anything
export ANTHROPIC_MODEL=muse-spark
export ANTHROPIC_DEFAULT_OPUS_MODEL=muse-spark
export ANTHROPIC_DEFAULT_SONNET_MODEL=muse-spark
export ANTHROPIC_DEFAULT_HAIKU_MODEL=muse-spark
export CLAUDE_CODE_SUBAGENT_MODEL=muse-spark

claude -p "your prompt here"
```

### Why all the `*_DEFAULT_*_MODEL` vars?

Claude Code has internal paths (Plan Mode, subagents, background tasks) that resolve a model by role (opus/sonnet/haiku) instead of by the main `ANTHROPIC_MODEL`. If any of those stay unset, that path tries to reach a real Claude model and fails because our proxy doesn't have one. Pin them all to `muse-spark` to keep every path on the Muse backend.

### Verifying your real account is untouched

```powershell
# Before
Get-Item ~/.claude/.credentials.json | Select-Object Length, LastWriteTime

# ... run claude ...

# After — should be identical
Get-Item ~/.claude/.credentials.json | Select-Object Length, LastWriteTime
```

## Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key="anything")

r = client.messages.create(
    model="muse-spark",
    max_tokens=1024,
    messages=[{"role":"user","content":"hi"}],
)
print(r.content[0].text)

# Streaming
with client.messages.stream(
    model="muse-spark",
    max_tokens=1024,
    messages=[{"role":"user","content":"count from 1 to 5"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

## curl

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: anything" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-spark","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

Streaming:
```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: anything" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-spark","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Request shape we accept

```json
{
  "model":      "muse-spark",
  "max_tokens": 1024,                    // IGNORED
  "messages": [
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "system":  "You are a helpful assistant.",   // optional, prefixed as "[system]"
  "stream":  false,
  "temperature": 0.7                     // IGNORED
}
```

`content` can be either a string or an array of blocks (`{type:"text", text:"..."}`). Both are supported.

## Response shape — non-stream

```json
{
  "id":    "msg_<uuid>",
  "type":  "message",
  "role":  "assistant",
  "model": "muse-spark",
  "content": [{"type": "text", "text": "..."}],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
```

## Response shape — stream (SSE)

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","content":[],"model":"muse-spark","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk 1"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk 2"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":NN}}

event: message_stop
data: {"type":"message_stop"}
```

## Known differences from real Anthropic

- `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` — all **silently ignored**.
- `usage.input_tokens` is always 0 (`count_tokens` returns a crude estimate but the actual message endpoints don't track it).
- No tool-use (`tools` / `tool_use` content blocks). Hatch's connectors are server-side-only.
- No vision / image content blocks. (The agent may support them server-side but we don't pass them through.)
- No `metadata.user_id`, no `anthropic-beta` features.
- Multi-turn `messages[]` is flattened into one prompt. Server-side agent memory is independent.

## Verified tools / clients

| Tool | Works? | Notes |
|---|---|---|
| Claude Code CLI (`claude -p`) | ✅ | tested end-to-end |
| Anthropic Python SDK (`anthropic>=0.25`) | ✅ (expected, API shape matches) | |
| curl | ✅ | |
| aichat / lmstudio / other Anthropic-compat tools | likely ✅ | sampling knobs ignored |

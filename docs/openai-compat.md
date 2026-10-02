# OpenAI compat — using the proxy with OpenAI tools

## Endpoint summary

```
POST  /v1/chat/completions   stream + non-stream
GET   /v1/models             returns one entry: muse-spark
```

Auth: `Authorization: Bearer <anything>` if `MUSE_PROXY_KEY` is unset. If set, header must match.

## Point an OpenAI SDK at it

### Python
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")

r = client.chat.completions.create(
    model="muse-spark",
    messages=[{"role":"user","content":"hi"}],
)
print(r.choices[0].message.content)

# Streaming
with client.chat.completions.stream(
    model="muse-spark",
    messages=[{"role":"user","content":"count from 1 to 5"}],
) as stream:
    for event in stream:
        if event.type == "content.delta":
            print(event.delta, end="", flush=True)
```

### Node.js
```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "anything" });
const r = await client.chat.completions.create({
  model: "muse-spark",
  messages: [{ role: "user", content: "hi" }],
});
console.log(r.choices[0].message.content);
```

### curl
```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer anything" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}'
```

Streaming:
```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer anything" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-spark","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Environment-variable style (for OpenAI-compat tools that read env)

PowerShell:
```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:8787/v1"
$env:OPENAI_API_KEY  = "anything"
<your tool here>
```

Bash:
```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=anything
<your tool here>
```

## Request shape we expect

```json
{
  "model":    "muse-spark",     // ignored by the proxy; always routes to Muse Spark
  "messages": [
    { "role": "system",    "content": "..." },      // optional, prefixed as "[system]"
    { "role": "user",      "content": "..." },      // required
    { "role": "assistant", "content": "..." }       // optional, prefixed as "[assistant previous turn]"
  ],
  "stream": false,                                   // set true for SSE
  "temperature": 0.7,                                // IGNORED
  "max_tokens": 1024                                 // IGNORED
}
```

**All sampling parameters are ignored.** Hatch doesn't expose a knob. The agent runs with its own defaults.

## Response shape — non-stream

```json
{
  "id":      "chatcmpl-<uuid>",
  "object":  "chat.completion",
  "created": 1790926461,
  "model":   "muse-spark",
  "choices": [{
    "index":   0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
}
```

Token counts are always zero (Hatch doesn't surface them).

## Response shape — stream

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"chunk 1"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"chunk 2"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Standard OpenAI SSE. First chunk emits the role, subsequent chunks are content deltas, final chunk has `finish_reason: "stop"`, terminator is `data: [DONE]`.

## Known differences from real OpenAI

- All sampling knobs (`temperature`, `top_p`, `max_tokens`, `n`, `logit_bias`, `tools`, `tool_choice`, `response_format`, ...) are **silently ignored**.
- `usage` is always zeros.
- No `logprobs`.
- No function/tool calling. Hatch has its own tools (connectors) which fire server-side when the agent decides; the OpenAI client won't see them.
- Multi-turn `messages` arrays are flattened into one prompt — the proxy doesn't maintain cross-request conversation state. Server-side agent memory may still kick in because you're using your real Meta account.
- `n` > 1 is not honored. You always get one choice.
- Model names are advisory. The actual model is Muse Spark, regardless of what you pass.

## Verified tools / clients

| Tool | Works? | Notes |
|---|---|---|
| OpenAI Python SDK (`openai>=1.0`) | ✅ | stream + non-stream |
| curl | ✅ | |
| Node.js `openai` package | ✅ (expected, not tested here) | |
| Continue.dev / Cursor / other IDE plugins | likely ✅ | basic OpenAI compat; sampling knobs will be ignored |

# November hardening — pool, abort, tokens, presentations, debug gate (16-11-2026)

## Goal

Four long-deferred items from the Phase 6 / phase 7 TODO list finally landed:
debug log gating, approximate token counts, cancel-on-disconnect, HatchClient
pooling, and `delta.presentation` surfacing.

## What I tried

### 1. Gate `proxy-debug.log`

Previously always-on (`!== "0"`). A long-running proxy would silently grow a
multi-GB log because `appendFileSync` with no rotation. Flipped to opt-in
(`=== "1"`). One-line change in two files (`src/hatch/chat.ts`,
`src/server/anthropic.ts`). Default is now zero-IO; `PROXY_DEBUG=1 npm start`
re-enables when needed. Log still single-file append-only; delete between runs.

### 2. Approximate token counts

Hatch exposes no tokenizer. Previously `usage` was zero everywhere. Added
`approxTokens(s) = Math.max(1, Math.ceil(s.length / 4))` in
`src/server/common.ts` and wired through:

- OpenAI non-stream: `usage: {prompt_tokens, completion_tokens, total_tokens}`
- OpenAI stream: final `choices: []` chunk with `usage` (OpenAI's own
  "include_usage" convention — standard SDKs accept it).
- Anthropic non-stream: `usage: {input_tokens, output_tokens}`
- Anthropic stream: `message_start.usage.input_tokens` + accumulated
  `message_delta.usage.output_tokens`.

Not a tokenizer. If clients care, swap for tiktoken (`js-tiktoken` works
offline, no API calls).

### 3. Cancel-on-disconnect

Hono exposes `c.req.raw.signal` — the standard Fetch `AbortSignal`. Threaded it
from server (`openai.ts`, `anthropic.ts`) through
`runChat` (`src/server/handler.ts`, `src/server/start.ts`) into
`sendAndCollectReply` (`src/hatch/chat.ts`). Every `while` loop condition
now short-circuits on `args.signal?.aborted`:

- Main-chat subscribe-and-collect loop
- Side-chat ack wait
- Side-chat history poll outer + inner loops

Abort breaks out and returns partial text. Does NOT close the pooled
`HatchClient` — the pool stays warm. Server-side the aborted stream is
zombified but `recvOne` dispatches by stream_id so leftover frames are
filtered + eventually GC'd by the chunk-assembly cap.

### 4. Connection pool (serialize)

Previously one Noise handshake per request → ~500 ms fixed cost. New module
`src/hatch/pool.ts`: single-client slot behind a FIFO mutex (promise-chain
style — `tail = new Promise(r => release = r); await gate`).

Rules:

- First `withClient` call opens; every subsequent call reuses.
- `fn` throws → close the slot, null it, next caller opens fresh.
- Explicit `reset()` + `peek()` for test hygiene.
- DI-friendly `openClient()` so tests fake the HatchClient without a real WS.

Caveats (not fixed, documented):

- Main-chat path re-sends `/chat/subscribe` + `/client/register-capabilities`
  per call on the shared client. Server-side subscribe streams pile up.
  Harmless in practice until it isn't; the lazy fix is to move those into
  `openClient()`.
- Serialized means one in-flight request at a time. Per-stream multiplex
  (dispatch `recvOne` by stream_id to per-caller queues) is the upgrade path
  if throughput bites.

Handler.ts bootstrap-retry logic still works: pool error → re-bootstrap →
retry once → pool's `openClient()` runs again with the fresh session.

### 5. Presentation surfacing (`x_muse_presentations`)

Muse pushes `delta.presentation`, `widget.state_updated`,
`delta.inline_option`, `task.status`, `approvals.snapshot` on the subscribe
stream. Previously dropped on the floor.

New type `PresentationEvent = {kind, ts_ms?, payload}` where `payload` is
the raw muse payload — no schema guesses, because we have no documented
shape to validate against. Passes through verbatim.

Wire extension (both proxies):

- **Non-stream**: top-level `x_muse_presentations: PresentationEvent[]`
  when non-empty; omitted when empty.
- **OpenAI stream**: `data: {choices: [], x_muse_presentation: {...}}` chunk
  per event, interleaved with text deltas in arrival order.
- **Anthropic stream**: `event: x_muse_presentation\ndata: {json}` SSE frame,
  interleaved with `content_block_delta` in arrival order.

Standard SDKs ignore unknown fields / events. Opt-in clients can read them.

Scope caveat: side-chat path (`X-Muse-Session` header) polls
`/chat/history` with no subscribe stream — presentations are never captured
there. Documented in README + `docs/anthropic-compat.md` +
`docs/openai-compat.md`.

## Gotchas (worth remembering)

1. **Hono stream vs AbortSignal.** Hono's `streamSSE` doesn't abort the
   inner async fn automatically when the client disconnects. The signal has
   to be read from `c.req.raw.signal` and threaded manually. The streamSSE
   wrapper only fails on write, which can happen much later than disconnect.
2. **Pool error path matters.** If `fn` returns normally after aborting the
   signal, the pool stays warm. If `fn` throws (e.g. WS reset), the pool
   closes + reopens. Design choice: abort = partial success, not failure.
3. **Presentation side-chat gap is permanent on the current design.** The
   side-chat path exists specifically to avoid the subscribe-stream race
   and uses history polling instead. History doesn't carry `delta.*`
   events, only completed messages. To surface presentations in side chats
   would require adding a scoped subscribe + reworking the poll loop —
   bigger than the problem deserves.
4. **OpenAI streaming usage chunk format.** OpenAI's "include_usage" convention
   is a final chunk with `choices: []` and a top-level `usage`. Emit it
   before `[DONE]`. SDKs that don't opt in ignore it; SDKs that do opt in
   get a number.

## Files touched

- `src/hatch/chat.ts` — PresentationEvent, allowlist, loop capture, signal
- `src/hatch/pool.ts` — new, serialize-pool
- `src/server/handler.ts` — pool integration, presentation + signal threading
- `src/server/start.ts` — AppDeps signature extension
- `src/server/openai.ts` — token counts, x_muse_presentation(s), signal
- `src/server/anthropic.ts` — token counts, x_muse_presentation(s), signal, debug gate flip
- `src/server/common.ts` — `approxTokens`
- `tests/fixes-token-abort.test.ts` — new, 7 tests
- `tests/pool.test.ts` — new, 5 tests
- `tests/presentations.test.ts` — new, 5 tests
- `README.md`, `docs/*.md` — docs refresh

## What's next

- Per-stream multiplex over the pool (concurrency, not just handshake amortization).
- Tokenizer-accurate counts if a client ever complains (`js-tiktoken`).
- Attestation chain verification (Phase 8) is the next structural gap.

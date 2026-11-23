# Project status

**Last updated:** 2026-11-23

One table, two columns: what's shipped, what isn't yet. If you're picking the project up on a new machine or after a break, start here.

## Shipped

| Feature | Where it lives | Memory note |
|---|---|---|
| Bootstrap flow (browser-mint `session.json`, auto re-bootstrap on first failure) | `src/bootstrap/`, `scripts/login.ts`, `src/server/handler.ts` | `01-10-2026-phase-1-bootstrap.md` |
| Noise XX handshake (`Noise_XX_25519_AESGCM_SHA256`) | `src/noise/` | `02-10-2026-phase-2-noise-handshake.md` |
| HTTP-over-Noise transport, ServiceFrame envelope, 48 KB chunking | `src/hatch/envelope.ts`, `transport.ts` | `02-10-2026-phase-4-chat-send.md` |
| Main-chat streaming (`delta.text_append` reassembly, replay filter) | `src/hatch/chat.ts` | `02-10-2026-phase-5-streaming-reply.md` |
| Side-chat routing via `X-Muse-Session` (poll-until-stable fallback) | `src/hatch/chat.ts`, `src/hatch/sessions.ts` | `05-10-2026-side-chat-routing.md` |
| OpenAI `/v1/chat/completions` + `/v1/models` (stream + non-stream) | `src/server/openai.ts` | `02-10-2026-phase-7-openai-anthropic-proxy.md` |
| Anthropic `/v1/messages` + `/v1/messages/count_tokens` (stream + non-stream) | `src/server/anthropic.ts` | `02-10-2026-phase-7-openai-anthropic-proxy.md` |
| Opt-in debug log (`PROXY_DEBUG=1 → ./proxy-debug.log`) | `src/server/anthropic.ts`, `src/hatch/chat.ts` | `16-11-2026-nov-hardening.md` |
| Token counts via `js-tiktoken` (`cl100k_base`), chars/4 fallback | `src/server/common.ts` | `16-11-2026-nov-hardening.md` (initial), tiktoken swap on branch `feat/tiktoken-counts` |
| Cancel-on-disconnect (Hono `AbortSignal` threaded through `runChat` + all poll loops) | `src/hatch/chat.ts`, `src/server/{openai,anthropic,handler,start}.ts` | `16-11-2026-nov-hardening.md` |
| Vendor-extension widget / card / inline-option surfacing (`x_muse_presentations` / `x_muse_presentation`) — main chat only | `src/hatch/chat.ts`, `src/server/{openai,anthropic}.ts` | `16-11-2026-nov-hardening.md` |
| Multiplex-pool HatchClient (per-stream dispatcher, concurrent requests on one WS, lazy-open mutex) | `src/hatch/pool.ts`, `src/hatch/client.ts`, `src/hatch/chat.ts` | `16-11-2026-multiplex-pool.md` |
| Attestation dump (`DUMP_ATTESTATION=1 → attestation-dump.json`) | `src/hatch/client.ts` | `16-11-2026-attestation-finding.md` |
| Attestation parser + `inspect:attestation` CLI (AMD SEV-SNP report, VCEK cert chain shapes, ReportDataInput freshness probe) | `src/noise/attestation.ts`, `src/cli/inspect-attestation.ts` | `16-11-2026-attestation-finding.md` |
| Missing / truncated reply fix — `MuseChatTimeoutError` on timeout or missing ack instead of an empty reply, final transcript / message text merged via `appendFinalText` / `extractTranscriptText` without duplication or truncation, 1.5 s `recvOne` slices, 5 s replay-filter tolerance | `src/hatch/chat.ts`, `src/server/handler.ts` | Commit `7c0d9d4` (2026-11-18), direct to `master` (no PR) |
| Per-session serialization — `SessionStore.runExclusive` wraps `runChat` so calls on the same session run one at a time; `MuseChatTimeoutError` is not retried / re-bootstrapped | `src/hatch/sessions.ts`, `src/server/handler.ts` | Commit `7c0d9d4` (2026-11-18) |
| Streaming suffix flush — any final reply text not yet streamed is emitted as a last chunk before finish on both protocol paths | `src/server/openai.ts`, `src/server/anthropic.ts` | Commit `7c0d9d4` (2026-11-18) |
| Full QA hardening pass (2026-11-23) — protocol-correct OpenAI/Anthropic error envelopes + status mapping (400/401/413/502/504), request-body validation (malformed JSON shapes return 400, never 500), Anthropic array-form `system` honoured + counted, `x-api-key` session derivation, stream errors no longer masked as successful completions, token usage counted once from full text, no retry after the user message has been sent upstream, dispatcher survives non-JSON bodies, decrypt failure is fatal (nonce desync), handshake timeouts + socket cleanup, session TTL enforced on the accessed key, pool no longer torn down by one caller's timeout, `.env` auto-load, complete `.env.example`, friendly startup errors (bad port/LOG_LEVEL, port-in-use, missing-session warning), `build` excludes tests, dead `bin` entry removed, `engines: node >=22` | repo-wide | QA pass 2026-11-23 (this commit) |
| OpenAI Responses API — `POST /v1/responses` (stream + non-stream), the only wire protocol current Codex CLI speaks (`wire_api = "chat"` removed upstream). Stateless translation onto the chat flow: `instructions` → system, input items flattened (`function_call` summarised, `function_call_output` forwarded, `reasoning` skipped), standard Responses SSE sequence with `response.failed` on error, request `tools` ignored (agent tools run server-side) | `src/server/responses.ts` | 2026-11-23; verified against Codex CLI 0.164 (config accepted, `/v1/responses` hit, streamed failure surfaced verbatim) |

Test coverage: **114 tests**, all green on `master` as of 2026-11-23 (verified locally: `npm install`, `npm run typecheck`, `npm run build`, `npm test`, plus live smoke tests of `/healthz`, `/v1/models`, all chat routes' error paths, `count_tokens`, and `/v1/responses` stream/non-stream with no login present).

## Pending

| Item | Why it's not done | Gating event |
|---|---|---|
| Second `HatchClient` in the pool (true pool, not just multiplex on one) | No throughput complaint on single-client multiplex | Observed muse rate-limit per-WS, or genuine concurrency ceiling |
| Pool-scoped `/chat/subscribe` + `/client/register-capabilities` (avoid N subscribes per N main-chat callers) | No server-side rejection seen | Muse ever disconnecting over too many subscribes |
| AMD SEV-SNP hard verification (ECDSA-P384 VCEK → ASK → ARK + CRL + sigstore/cloudflare transparency proof) | Parser is ready, but muse currently serves `Platform: NON_TEE` — nothing to verify. See `memory/16-11-2026-attestation-finding.md` | Muse flipping to `AMD_SEV_SNP` evidence |
| Confirm `ReportDataInput.x25519_public_key == server static rs` | Needs one more capture with the updated dump (which now records `server_static_pub_b64`) | User runs `DUMP_ATTESTATION=1 npm start` once + `npm run inspect:attestation` |
| Tokenizer-accurate counts for Claude vocab | `cl100k_base` is close enough and SDK side ignores exact count | Real complaint from an Anthropic client |
| Proxy-side multi-turn conversation state | Agent holds server-side memory via your real Meta account; flatten works | User reporting lost context between calls |
| Vision / image input on Anthropic path | Not sure muse accepts image parts on `/chat/stream` input | Captured example of muse accepting one |

## Blocked externally

- **AMD SEV-SNP evidence** — muse is sending `Platform: NON_TEE` bundles. The infra here is ready for the day they flip, but today there is literally no signed report to verify. See `memory/16-11-2026-attestation-finding.md`.

## When you resume

1. `git pull` and skim this file.
2. `npm install`, `npx playwright install chromium`, `npm run login`.
3. `npm start`, hit `/healthz`, you're back.
4. Check the latest memory entry for context on what was last in flight.

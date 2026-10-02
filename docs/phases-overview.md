# Phases overview — what each phase builds and why

The repo is organized phase-by-phase to make it skimmable. Each phase has:
- A single purpose
- Its own README with run instructions
- A dated memory/ entry explaining the journey (what was tried, what worked, gotchas)

## Phase 0 — Recon (`recon/`)

Figure out whether a web2api proxy is even possible. Browse the live muse.ai, grep the compiled JS bundles, decide on a crypto suite, map the bootstrap endpoints. Deliverables: 9 captured JS chunks, grep catalogs, Phase 0 report.

Verdict: possible. Noise XX, standard primitives, server-attested handshake.

## Phase 1 — Bootstrap (`phase1/`)

HTTP cookie → `session.json` with a ready-to-use Noise WS URL. Four POST calls on muse.ai with the user's session cookies.

Hardest part: TLS/UA fingerprinting. Fixed with `curl_cffi` + explicit UA header overrides.

Output: `phase1/session.json` with `vm_id`, `gateway_url`, `auth_token`, `notary_token`, and the fully-built `ws_url`.

## Phase 2 — Noise handshake + frame recorder (`phase2/`)

Open the Noise WS, do the 3-message XX handshake, split cipher states, record every decrypted frame.

Hardest part: msg1 payload shape (32-byte CSPRNG nonce in protobuf field 1 — not empty). Server idle-closes if no immediate first encrypted frame post-handshake; we send a 16-byte empty kick.

Output: a working Noise channel + 5 extracted FileDescriptorProto schemas.

## Phase 3 — HTTP-over-Noise + route discovery (`phase3/`)

Decode the extracted protos. Discover: **the transport is HTTP semantics in protobuf.** `ServiceFrame.ApplicationRequest` carries verb/path/headers/body. Sweep probes to enumerate 15+ live DAEMON endpoints.

Hardest part: realizing the server returns human-readable error messages that spell out exactly what field is missing. Fastest route-discovery mechanism I've ever used.

Output: a known-good list of HTTP endpoints the Hatch VM exposes.

## Phase 4 — Send human chat messages (`phase4/`)

Discover the human-chat endpoint. Phase 3's `POST /chat/send` with `kind=action` worked but the server explicitly said "requires kind=action" meaning `kind=user` is on a different route.

Hardest part: path literals are minified beyond grep. Solved by monkey-patching `crypto.subtle.encrypt` via `page.addInitScript` and searching the hex log for an ASCII marker typed into the real UI.

Discovery: `POST /chat/stream` (not `GET`) with body `{message, node_id, capabilities, timezone}`.

## Phase 5 — Streaming reply (part of `phase4/chat.py` final version)

Phase 4's send got a sync ack but the streamed assistant tokens went to the browser, not us. Phase 5 finds the subscribe mechanism.

Hardest part: realizing `/chat/subscribe` is a long-lived stream (never ends, server keeps pushing). And realizing `/client/register-capabilities` is required BEFORE subscribe to register our connection as the push target.

Discovery: full flow is `register → subscribe → stream` with the same UUID as both `client_id` and `node_id`, then collect `delta.text_append` events on the subscribe stream_id (filtered by timestamp to drop replays).

Output: `phase4/chat.py` can now take a user prompt and return the agent's full streamed reply.

## Phase 6 — (merged into Phase 7)

Was going to be "production hardening" (reconnect / token refresh / threading). Scope-reduced to a single feature: Phase 7's server auto-reruns `bootstrap.py` once on first `HatchClient` failure.

Rest of Phase 6 (connection pooling, cancel-on-disconnect, real token counts) deliberately skipped — add when a real user complains.

## Phase 7 — OpenAI + Anthropic compat proxy (`phase7/`)

FastAPI server exposing both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) wire formats, stream + non-stream. Each request opens a fresh Noise session, runs the Phase 5 chat flow, formats the reply in the client's native shape.

Hardest part: Claude Code integration. Had to add `/v1/messages/count_tokens` stub and ServiceRequest chunking (Claude Code sends 50-200KB system prompt + MCP tools context, exceeds Hatch's 65KB per-frame limit).

Output: a drop-in muse.ai backend for any OpenAI or Anthropic SDK.

## What the phases DON'T do

| Not built | Why |
|---|---|
| Attestation chain verification | Phase 2 logs the mismatch but doesn't verify. Would require parsing `attestation_bundle.proto` and ed25519 sig verification. Non-trivial, not blocking usage. |
| Multi-turn conversation threading in the proxy | Flattening works. Agent has its own server-side memory. |
| Image / widget / presentation surfacing | Hatch pushes `delta.presentation` events; proxy ignores them. Add if a caller needs. |
| Real token counts | Hatch doesn't expose a tokenizer. Could estimate client-side with tiktoken but faked zeros are more honest. |
| Cancel on client disconnect | `delta.message_done` always arrives eventually; client-disconnect-aborts-generation is a nice-to-have. |
| Noise connection pooling | ~500ms per request handshake overhead is tolerable. Pooling adds complexity around register-capabilities scoping. |

## Timing budget (if you continue)

| Would-be-next | Rough estimate |
|---|---|
| Attestation verification (Phase 8) | 3-5 days |
| Connection pooling | 1-2 days |
| Widget / presentation surfacing | 1-2 days per widget type |
| Multi-turn session state | 1 day (keyed by request ID or user ID) |
| Deploy as a hosted service with TLS + auth | 1 day |

Total elapsed to date: ~8-10 hours from zero to Claude Code working end-to-end.

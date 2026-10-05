# muse-ai-api

Reverse-engineered Node.js client + OpenAI/Anthropic-compatible proxy for Meta's **muse.ai** (Hatch) personal agent.

Lets you call the Muse Spark model (and the agent behind it) from any OpenAI or Anthropic SDK by pointing it at a local proxy.

## ⚠️ Status, scope, and legal

- **Research / interop demo, not a product.** Everything here was figured out by observing the browser from the outside: no insider info, no Meta source. It is _fragile_ by construction — Meta ships hatch-web updates frequently and any of them can break things.
- **Uses your own Meta login.** You authenticate to muse.ai in a browser as yourself, dump the session cookies, and the code impersonates _your_ browser. The server sees your real account the whole time.
- **No bypass of pay/auth.** Anything the muse.ai web UI lets you do, this lets you script. Anything behind an ACL (e.g. certain `/chat/stream` ACLs) still returns 403 for us too.
- **Meta's ToS and your local law apply.** Reverse-engineering of client protocols sits in a gray area in most jurisdictions. If your use case needs legal certainty, use Meta's official [Model API](https://dev.meta.ai/) — same underlying model, documented, supported, and OpenAI-compatible out of the box. This repo is for people who want the _agent_, not just the _model_.
- **Expect takedowns / updates.** If you fork or redistribute, understand you may be subject to DMCA or similar notices.

## What's in here

```
index.ts            Entry point
src/
├── config.ts            zod env validation
├── log.ts               pino logger
├── bootstrap/           phase1 equivalent (HTTP cookies -> session.json)
├── noise/               phase2 equivalent (Noise XX hand-rolled on @noble/*)
├── proto/
│   ├── schemas/*.binpb  5 FileDescriptorProto blobs
│   ├── loader.ts        protobufjs dynamic loader
│   └── types.ts         hand-typed message shapes
├── hatch/               phase3+4+5 equivalent (HTTP-over-Noise client, chat flow)
├── server/              phase7 equivalent (Hono OpenAI + Anthropic proxy)
└── cli/                 CLI entries
docs/                 reference — architecture, wire protocol, API, compat, troubleshooting
memory/               dated session logs — the "why" behind every design decision
recon/                phase 0 — JS chunks, grep catalogs, decoded protobuf descriptors
```

- **Just want to use it?** → [docs/phases-overview.md](docs/phases-overview.md) → [docs/anthropic-compat.md](docs/anthropic-compat.md) or [docs/openai-compat.md](docs/openai-compat.md).
- **Want to understand how it works?** → [docs/architecture.md](docs/architecture.md) → [docs/wire-protocol.md](docs/wire-protocol.md) → [docs/request-flow.md](docs/request-flow.md) → [docs/api-reference.md](docs/api-reference.md).
- **Want to extend it?** → [docs/development.md](docs/development.md) + the relevant [memory/](memory/) entry.
- **Something broken?** → [docs/troubleshooting.md](docs/troubleshooting.md).
- **Want the story of how this got built?** → [memory/README.md](memory/README.md) walks through the full history chronologically.

## Quick start

```bash
npm install

# Dump your logged-in muse.ai cookies via Playwright or your browser into ./storage_state.json

npm run bootstrap    # Produces session.json
npm start            # Runs the OpenAI+Anthropic proxy on 127.0.0.1:8787
```

Then point any OpenAI or Anthropic SDK at the proxy:

```bash
# OpenAI:
OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=anything  <your tool>

# Anthropic (e.g. Claude Code):
ANTHROPIC_BASE_URL=http://127.0.0.1:8787  ANTHROPIC_AUTH_TOKEN=anything
ANTHROPIC_MODEL=muse-spark  ANTHROPIC_DEFAULT_OPUS_MODEL=muse-spark
```

## What works today

- Noise `Noise_XX_25519_AESGCM_SHA256` handshake with Hatch (hand-rolled on `@noble/curves` + `@noble/ciphers` + `@noble/hashes`).
- HTTP-over-Noise ServiceFrame transport, with per-request chunking across NoiseTransportFrames (~65 KB per frame limit).
- 15+ live DAEMON HTTP endpoints discovered: `/healthz`, `/health` (big VM state blob), `/version`, `/feed`, `/ideas`, `/goals`, `/connectors`, `/model`, `/identity`, `/approvals`, `/chat/history`, `/chat/subscribe`, `/chat/stream`, …
- Human-user chat: `POST /chat/stream` with proper subscribe+register preamble, streamed `delta.text_append` events reassembled into a final reply.
- **Per-API-session side chats** — pass `X-Muse-Session: <any-string>` and the proxy creates a dedicated side chat on muse.ai for that key, continues it on subsequent calls, isolates history from other sessions. Omit the header → shared main chat (backward compatible). See [docs/architecture.md §2a](docs/architecture.md) and [memory/05-10-2026-side-chat-routing.md](memory/05-10-2026-side-chat-routing.md).
- OpenAI `/v1/chat/completions` (stream + non-stream) and Anthropic `/v1/messages` (stream + non-stream) wire formats.
- Automatic session re-bootstrap on first HatchClient open failure.

## Known limits

- Text only. The agent can push images / widgets / app cards (`delta.presentation` events). Those are logged but not surfaced to the OpenAI/Anthropic client.
- Multi-turn conversation threading is server-side only. The proxy flattens your `messages[]` into a single prompt per request.
- Faked token counts (zeros). Hatch does not expose a tokenizer.
- No cancel-on-disconnect. A dropped client doesn't abort the in-flight Hatch request.
- No connection pooling — one Noise handshake per proxy request (~500 ms).
- Only tested on Windows 11 + Node 22. Most things should work elsewhere.

## Non-obvious things I discovered the hard way

- Hatch 403s stock TLS/HTTP2 fingerprint on authenticated endpoints. Use `cycletls` with Chrome impersonation and _also_ pin `User-Agent` + `sec-ch-ua*` headers to match the browser that minted the session cookie (session is UA-bound). Hatch WS upgrade goes via Node's native `WebSocket` — unknown whether Hatch enforces JA3 on WS.
- `GET /chat/stream` → 403, `POST /chat/stream` → 200. ACL is per-verb-per-path.
- `kind: "action"` on `/chat/send` works over noise; `kind: "user"` is server-side-blocked. The human-user path is `/chat/stream`, not `/chat/send`.
- The subscribe stream is long-lived; each inbound `body_chunk` on it is one complete JSON event (`{event, payload, ts_ms, seq}`). `end_body` is never set on that stream.
- Need `POST /client/register-capabilities` BEFORE `POST /chat/subscribe` and use the same `client_id` as `node_id` in `/chat/stream`, otherwise server routes pushed events to another registered client (e.g. your open browser tab).
- Protobuf field names come off the wire in `snake_case`, not `camelCase` — despite protobufjs defaulting to camelCase in some configurations.
- Large system prompts (Claude Code sends 50–200 KB) must be chunked into 48 KB NoiseTransportFrames; the server silently drops frames that exceed the limit.
- When finding minified paths fails, monkey-patch `crypto.subtle.encrypt` via Playwright `page.addInitScript` and search the hex log for an ASCII marker you type into the real UI. It will give you the plaintext of every outgoing Noise frame.

## License

MIT — [LICENSE](LICENSE). Free and open for every use: personal, commercial, modification, redistribution, sublicensing, academic. No warranty.

## Credits

Nothing novel — the pieces (Noise, protobuf, Hono, @noble, cycletls) are all off the shelf. The work was figuring out which pieces to glue together and in what order.

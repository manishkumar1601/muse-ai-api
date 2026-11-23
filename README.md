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

- **What's done, what's pending** → [docs/status.md](docs/status.md).
- **Just want to use it?** → [docs/phases-overview.md](docs/phases-overview.md) → [docs/anthropic-compat.md](docs/anthropic-compat.md) or [docs/openai-compat.md](docs/openai-compat.md).
- **Want to understand how it works?** → [docs/architecture.md](docs/architecture.md) → [docs/wire-protocol.md](docs/wire-protocol.md) → [docs/request-flow.md](docs/request-flow.md) → [docs/api-reference.md](docs/api-reference.md).
- **Want to extend it?** → [docs/development.md](docs/development.md) + the relevant [memory/](memory/) entry.
- **Something broken?** → [docs/troubleshooting.md](docs/troubleshooting.md).
- **Want the story of how this got built?** → [memory/README.md](memory/README.md) walks through the full history chronologically.

## Quick start

### Prerequisites

- Node.js **22+**
- A working **muse.ai** account you can log into with your Meta credentials
- Tested on Windows 11. Should also run on macOS / Linux + Node 22

### 1. Clone + install

```bash
git clone https://github.com/manishkumar1601/muse-ai-api.git
cd muse-ai-api
npm install
npx playwright install chromium   # one-time; needed by `npm run login`
# Linux: use `npx playwright install --with-deps chromium` so the OS
# libraries Chromium needs are installed too.
# Note: `npm run login` opens a real browser window — you need a desktop
# display (it won't work over a plain SSH session without X forwarding).
```

Optional configuration: copy `.env.example` to `.env` — the proxy loads
it automatically at startup (shell exports take precedence).

### 2. Log in to muse.ai (one-shot)

```bash
npm run login
```

A Chromium window opens. Log in with your Meta account. When you see the muse.ai chat UI, come back to the terminal and press Enter. The script writes:

- `storage_state.json` — your browser cookies
- `session.json` — Hatch session tokens (short-lived; re-run `npm run login` when they expire)

Both are gitignored.

### 3. Start the proxy

```bash
npm start
```

Logs `{"msg":"listening","host":"127.0.0.1","port":8787}`. Leave it running in its own terminal.

Sanity check:

```bash
curl http://127.0.0.1:8787/healthz   # {"ok":true}
curl http://127.0.0.1:8787/v1/models # one model entry: muse-spark
# (if you set MUSE_PROXY_KEY, add: -H "Authorization: Bearer <your-key>")
```

### 4. Use with Claude Code (scoped to the shell — won't touch your global `~/.claude` config)

**PowerShell** (uses the bundled helper):

```powershell
. .\scripts\use-with-claude.ps1
claude
```

Isolated per-project side chat (recommended — keeps muse.ai threads separate):

```powershell
. .\scripts\use-with-claude.ps1 my-project-name
claude
```

**Bash / zsh** (Linux + macOS — use the bundled helper, must be sourced):

```bash
. ./scripts/use-with-claude.sh            # or: . ./scripts/use-with-claude.sh my-project-name
claude
```

Close the shell → Claude Code reverts to your real Anthropic account.

### 5a. Use with Codex CLI (current versions)

Current Codex only speaks the OpenAI **Responses API** (`wire_api = "chat"` was removed upstream) and ignores `OPENAI_BASE_URL` — it must be configured in `config.toml`. The proxy serves `POST /v1/responses` for exactly this.

**Easy way — the bundled helper** (keeps your normal Codex login untouched; it uses a separate `CODEX_HOME` at `~/.codex-muse` and generates a config there for you — the provider block below, plus `model`/`model_provider` defaults at the top):

```powershell
. .\scripts\use-with-codex.ps1            # Windows; then run: codex
```
```bash
. ./scripts/use-with-codex.sh             # Linux/macOS; then run: codex
```

**Manual way** — add the provider to `%USERPROFILE%\.codex\config.toml` (or `$CODEX_HOME\config.toml`):

```toml
[model_providers.muse]
name = "Muse Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then either make it your default (`model = "muse-spark"` + `model_provider = "muse"` at the top of `config.toml`), or keep your normal Codex account as default and add a profile — profiles live in their **own file**, `%USERPROFILE%\.codex\muse.config.toml`:

```toml
model = "muse-spark"
model_provider = "muse"
```

```powershell
$env:OPENAI_API_KEY = "anything"
codex --profile muse "reply with exactly: codex-ok"
```

Plain `codex` still uses your logged-in account — nothing is logged out or overwritten. (A "Model metadata for muse-spark not found" warning from Codex is expected and harmless.) Note the proxy is stateless for Responses: Codex already resends the full conversation each turn, and tool definitions are ignored — the Muse agent runs its own tools server-side and answers in text.

### 5b. Use with OpenAI SDK / Continue.dev / any Chat-Completions client

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=anything
export OPENAI_MODEL=muse-spark
# Optional per-session isolation:
export OPENAI_DEFAULT_HEADERS='{"X-Muse-Session":"my-project-name"}'
```

Anything that respects `OPENAI_BASE_URL` will hit the proxy.

**Python example**:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")
print(client.chat.completions.create(
    model="muse-spark",
    messages=[{"role":"user","content":"hello"}],
).choices[0].message.content)
```

### 5c. All coding agents — one helper script each (Windows + Linux + macOS)

Every agent gets a matched pair of scripts in `scripts/`. All of them are **shell-scoped**: they change no global settings, never touch the agent's own logged-in account or config, and closing the shell reverts the routing. (Two of them also write a small config file into their own dedicated folder — `~/.codex-muse/config.toml` for Codex, `~/.muse-proxy/opencode.json` for OpenCode — which simply sits unused once the shell is closed.) Each takes an optional **session name** — see §6 for why that matters (resume).

| Agent | Windows (PowerShell) | Linux / macOS (bash/zsh) | Then run |
|---|---|---|---|
| Claude Code | `. .\scripts\use-with-claude.ps1 [name]` | `. ./scripts/use-with-claude.sh [name]` | `claude` |
| Codex | `. .\scripts\use-with-codex.ps1 [name]` | `. ./scripts\use-with-codex.sh [name]` | `codex` |
| OpenCode | `. .\scripts\use-with-opencode.ps1 [name]` | `. ./scripts\use-with-opencode.sh [name]` | `opencode` |
| Aider | `. .\scripts\use-with-aider.ps1 [name]` | `. ./scripts\use-with-aider.sh [name]` | `aider --model openai/muse-spark` |
| Any OpenAI-compatible client | `. .\scripts\use-with-openai.ps1 [name]` | `. ./scripts\use-with-openai.sh [name]` | your client |

### 6. Resuming an existing chat

A conversation lives in a **named side chat** on muse.ai. The name is how you get back to it:

1. Start a chat with a session name, e.g. `. .\scripts\use-with-claude.ps1 my-project` (or `use-with-codex`, `use-with-opencode`, … — same idea on every agent).
2. Close the terminal, reboot, come back tomorrow — it doesn't matter.
3. Run the same script with **the same name** again and keep talking. The agent reconnects to the same muse.ai side chat with its full history — the model remembers what you discussed.

How it works: the name travels as the `X-Muse-Session` header (or, for agents that can't send headers like Codex/Aider, inside the API token as `proxy-<name>`). The proxy maps the name to the muse.ai chat and **persists that mapping to `sessions-store.json`** (see `MUSE_SESSIONS_STORE_PATH`), so resume survives proxy restarts too. Mappings expire after 24h of inactivity. To forget all of them and start fresh: stop the proxy, delete `sessions-store.json`, restart (a running proxy keeps the mappings in memory and would rewrite the file). Different name = different chat; no name = one default chat shared by every agent (they all present the same `proxy` token when unnamed — use names when you want chats kept apart).

### Troubleshooting (quick)

- **`{"error":{"message":"bootstrap failed..."}}`** — cookies expired. Re-run `npm run login`.
- **PowerShell curl JSON errors** — single-quoted strings in PS pass `"` verbatim but Windows strips them again. Use `Invoke-RestMethod` or send the body via `--data-binary "@body.json"`.
- **Attestation dump** — set `DUMP_ATTESTATION=1` before `npm start` to write `attestation-dump.json` on the next handshake; `npm run inspect:attestation` decodes it.
- **Verbose proxy log** — set `PROXY_DEBUG=1` before `npm start` to append per-chunk + per-poll diagnostics to `./proxy-debug.log`.

Everything else: [docs/troubleshooting.md](docs/troubleshooting.md).

## What works today

- Noise `Noise_XX_25519_AESGCM_SHA256` handshake with Hatch (hand-rolled on `@noble/curves` + `@noble/ciphers` + `@noble/hashes`).
- HTTP-over-Noise ServiceFrame transport, with per-request chunking across NoiseTransportFrames (~65 KB per frame limit).
- 15+ live DAEMON HTTP endpoints discovered: `/healthz`, `/health` (big VM state blob), `/version`, `/feed`, `/ideas`, `/goals`, `/connectors`, `/model`, `/identity`, `/approvals`, `/chat/history`, `/chat/subscribe`, `/chat/stream`, …
- Human-user chat: `POST /chat/stream` with proper subscribe+register preamble, streamed `delta.text_append` events reassembled into a final reply.
- **Per-API-session side chats** — pass `X-Muse-Session: <any-string>` and the proxy creates a dedicated side chat on muse.ai for that key, continues it on subsequent calls, isolates history from other sessions. Omit the header and the proxy derives a side chat from your API token instead; omit both header and token → shared main chat. Session names are routing labels, not secrets — anyone with your proxy key who guesses a name shares that side chat. See [docs/architecture.md §2a](docs/architecture.md) and [memory/05-10-2026-side-chat-routing.md](memory/05-10-2026-side-chat-routing.md).
- OpenAI `/v1/chat/completions` (stream + non-stream) and Anthropic `/v1/messages` (stream + non-stream) wire formats.
- Automatic session re-bootstrap on first HatchClient open failure.
- **Multiplex-pool HatchClient** — one Noise handshake amortized across all requests; concurrent requests multiplex over a single WS via per-stream dispatch. First caller pays ~500 ms handshake; the rest overlap. Closes + reopens on error.
- **Token counts** via `js-tiktoken` (`cl100k_base` encoder) on `usage` for both OpenAI and Anthropic, stream + non-stream. Accurate for GPT-4-family, close-enough for Claude. Chars/4 fallback if the encoder fails to load.
- **Cancel-on-disconnect** — Hono's request `AbortSignal` is threaded through `runChat` into every poll loop; a dropped HTTP client breaks out of chat waits + returns partial text.
- **Images / widgets / app cards** surfaced as vendor extension `x_muse_presentations` / `x_muse_presentation`. Main chat only.
- **Opt-in debug log** — set `PROXY_DEBUG=1` to append per-chunk + per-poll diagnostics to `./proxy-debug.log`. Off by default.

## Known limits

- `x_muse_presentations` is captured on the main chat only — side chat (`X-Muse-Session`) polls `/chat/history` and never sees `delta.*` events.
- Multi-turn conversation threading is server-side only. The proxy flattens your `messages[]` into a single prompt per request.
- Token counts use `cl100k_base` — accurate for OpenAI clients, approximate for Anthropic (Claude's vocab differs). Hatch itself exposes no tokenizer; this is a client-side estimate.
- Pool multiplexes over one HatchClient; opening a second client is not implemented (if muse ever rate-limits per-WS we would need a client-set here).
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

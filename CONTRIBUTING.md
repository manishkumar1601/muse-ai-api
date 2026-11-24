# Contributing to muse-ai-api

Thanks for your interest! This project is a research / interop demo that turns
the Muse AI web app into an OpenAI- and Anthropic-compatible local API. Please
read the "Status, scope, and legal" section of the [README](README.md)
before contributing — in particular: it uses your own Meta
login, bypasses nothing, and is fragile by construction because the upstream
web app changes often.

## Getting set up

Prerequisites: **Node.js 22+** and Git. Windows 11, Ubuntu/Linux and macOS
are all supported.

```bash
git clone https://github.com/manishkumar1601/muse-ai-api.git
cd muse-ai-api
npm install
npx playwright install chromium   # Linux: add --with-deps
npm run login                     # opens a browser; log in to muse.ai, press Enter
npm start                         # proxy on http://127.0.0.1:8787
```

Sanity checks: `curl http://127.0.0.1:8787/healthz` → `{"ok":true}`, and
`curl http://127.0.0.1:8787/v1/models` → one model, `muse-spark`.

## Development workflow

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm run build       # tsc -p tsconfig.build.json (excludes tests)
npm test            # node --test — all tests must pass
```

- The test suite is fully offline (mocked upstream). **Never** write a test
  that needs a real muse.ai login or network access.
- If you change behavior, add or update tests in `tests/` in the same PR.
- Update the docs in the same PR: `README.md` for user-facing behavior,
  `docs/` for protocol/compat details, and add a row to the shipped table in
  `docs/status.md` — that page is the project's resume point, keep it true.

## Project conventions

- **Errors are protocol-shaped.** OpenAI routes return
  `{"error":{"type","message"}}`, Anthropic routes return the Anthropic
  envelope; use the helpers in `src/server/errors.ts`. Malformed request
  bodies are a `400`, never a `500`.
- **Token/session routing.** Session keys come from `X-Muse-Session` or the
  bearer token (`src/hatch/sessions.ts`). Named sessions persist to
  `sessions-store.json` so chats can be resumed — don't break that mapping.
- **PowerShell scripts (`.ps1`) must be pure ASCII.** Windows PowerShell 5.1
  reads `.ps1` files without a BOM as ANSI, and UTF-8 punctuation (em-dashes,
  checkmarks) decodes into characters that break its parser.
- **Shell scripts (`.sh`) must work sourced in both bash and zsh**, and must
  refuse to run when executed instead of sourced.
- Helper scripts in `scripts/` are shell-scoped only: they must never modify
  an agent's global config, credentials, or logged-in account.

## Never commit secrets or session material

These files contain live credentials and are gitignored on purpose — a PR
that adds any of them will be rejected:

- `session.json`, `storage_state.json`, `sessions-store.json`, `.env`
  (commit `.env.example` changes instead)

Also never paste real session cookies, tokens, or `ws_url` values into
issues, PRs, logs, or test fixtures. Redact them first.

## Submitting a pull request

1. Fork, branch from `master`, and keep the change focused.
2. Run `npm run typecheck && npm run build && npm test` locally.
3. Use a conventional commit message (`feat:`, `fix:`, `docs:`, `test:` …).
4. Fill in the PR template checklist.
5. Describe *how you verified* the change (tests run, a live smoke test,
   which agent/OS you tried). "It compiles" is not verification for
   protocol or agent-facing changes.

## Reporting bugs and requesting features

Use the issue templates. For anything security-sensitive, do **not** open a
public issue — follow [docs/security.md](docs/security.md) instead.

Questions about the wire protocol: check `docs/wire-protocol.md` and
`docs/architecture.md` first; `docs/status.md` lists what is known to work
and what is still gated.

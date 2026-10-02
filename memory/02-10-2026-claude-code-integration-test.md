# Claude Code integration test (02-10-2026)

## Goal

Point the user's existing Claude Code CLI at the Phase 7 proxy, verify the agent replies correctly, and **make absolutely sure the user's real Anthropic account on their Claude Code install isn't disturbed**.

## What I tried

1. **Baseline recorded**:
   ```
   ~/.claude/.credentials.json  : 529B, Oct 2 10:37
   ~/.claude/settings.json      : 2702B, Oct 2 11:45
   ```
2. **Started the proxy** (`python -m uvicorn phase7.server:app --host 127.0.0.1 --port 8787`) in a background task.
3. **Spawned Claude Code in a child PowerShell** with env vars set only within that subprocess:
   ```powershell
   $env:ANTHROPIC_BASE_URL        = "http://127.0.0.1:8787"
   $env:ANTHROPIC_AUTH_TOKEN      = "x"
   $env:ANTHROPIC_MODEL           = "muse-spark"
   $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = "muse-spark"
   $env:ANTHROPIC_DEFAULT_SONNET_MODEL = "muse-spark"
   $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = "muse-spark"
   $env:CLAUDE_CODE_SUBAGENT_MODEL = "muse-spark"
   "" | claude -p "say exactly: muse-proxy-via-claude-ok"
   ```
4. **First try hung** — Claude Code probes `/v1/messages/count_tokens` before every send; we 404'd and it hung. Added `count_tokens` stub to the server.
5. **Second try CLOSE_NOTIFY** — Hatch tore down the Noise WS because Claude Code's system prompt + tools context payload exceeded ~65KB per-frame. Added ServiceRequest chunking in `phase4/chat.py`.
6. **Third try succeeded.** Claude Code's stdout:
   ```
   muse-proxy-via-claude-ok
   ```
   Server log confirmed the full flow:
   ```
   [req ] GET /healthz          → 200 (0ms)
   [req ] HEAD /                → 405 (2ms)
   [req ] POST /v1/messages     → 200 (6ms)    (count_tokens-shaped probe)
   [req ] POST /v1/messages                     (actual chat request)
   ```
7. **After-test baseline check**:
   ```
   ~/.claude/.credentials.json  : 529B, Oct 2 10:37   (unchanged)
   ~/.claude/settings.json      : 2702B, Oct 2 11:45   (unchanged)
   ```
   User's real OAuth token + settings untouched.

## What worked

- **Env vars scoped to child subprocess only.** PowerShell `$env:X=...` persists for the current shell only, and the shell exits after the command. Zero writes to `~/.claude/`.
- `"" | claude -p "..."` to pipe empty stdin and avoid Claude's "waiting for stdin" warning.
- Server auto-rebootstrap wasn't triggered (session was fresh), but the code path exists.

## Gotchas (worth remembering)

1. **Claude Code calls `/v1/messages/count_tokens`** before every send. Return a stub or you hang.
2. **Claude Code's actual request body is big** (system prompt + CLAUDE.md + MCP tools + conversation state). Expect 50-200KB. Must chunk ServiceRequests.
3. **Env vars don't touch stored OAuth.** Verified: creds file size + mtime unchanged.
4. **`claude -p` is one-shot non-interactive.** Never writes to settings. Safe for scripted use.
5. **To revert**: close the shell. Env vars are gone. Next `claude` invocation uses the real stored token.

## Server stopped at end of test

Task `bgt4jc2ob` stopped via `TaskStop`. Port 8787 freed. Verified `curl http://127.0.0.1:8787/healthz` fails with URLError.

## Verdict

The proxy is drop-in compatible with Claude Code's Anthropic API client, and switching between the real Anthropic account and the Muse backend is a shell-scope env-var change — no config file edits, no persistent state.

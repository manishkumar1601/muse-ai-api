# E2E tests (manual, Windows / PowerShell)

Verify the Node proxy against real tools:

1. From the repo root: `npm run login` (creates `storage_state.json` + `session.json`; skip if both are still fresh — `npm run bootstrap` alone refreshes `session.json`)
2. `npm start` in one shell
3. In another shell: `cd tests/e2e`, then run `./test-claude-code.ps1` and `./test-codex.ps1`

Both scripts set env vars scoped to the child subprocess only. They do NOT modify global config or settings. Verified by checking `~/.claude/.credentials.json` and `~/.claude/settings.json` mtimes before/after.

There are no macOS/Linux equivalents yet — on those platforms, point the tools at the proxy with the shell exports from the main README instead.

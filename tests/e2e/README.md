# E2E tests (manual)

Verify the Node proxy against real tools:
1. `npm run bootstrap` (needs fresh storage_state.json)
2. `npm start` in one shell
3. In another shell, run `./test-claude-code.ps1` and `./test-codex.ps1`

Both scripts set env vars scoped to the child subprocess only. They do NOT modify global config or settings. Verified by checking `~/.claude/.credentials.json` and `~/.claude/settings.json` mtimes before/after.

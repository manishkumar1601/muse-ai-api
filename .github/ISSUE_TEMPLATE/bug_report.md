---
name: Bug report
about: Something in the proxy, a helper script, or an agent integration is broken
title: "[bug] "
labels: bug
---

**What happened**
A clear description of the bug and what you expected instead.

**Steps to reproduce**
1. Command / request you ran (redact any tokens or cookies!):
2. Proxy terminal output:
3. Response or error you got:

**Environment**
- OS: (Windows 11 / Ubuntu / macOS + version)
- Node version: (`node -v`)
- Shell, if a script is involved: (PowerShell 5.1 / PowerShell 7 / bash / zsh)
- Client, if relevant: (Claude Code / Codex + version / OpenCode / Aider / curl / SDK)

**Which route or area**
- [ ] `/v1/chat/completions`
- [ ] `/v1/responses` (Codex)
- [ ] `/v1/messages` (Anthropic)
- [ ] Login / bootstrap (`npm run login`)
- [ ] Helper script (`scripts/use-with-*`)
- [ ] Sessions / resume
- [ ] Docs
- [ ] Other

**Anything else**
Relevant config (`.env` variable *names* only — never values), recent changes,
or whether it worked before. Reminder: never paste `session.json`,
`storage_state.json`, cookies, or live tokens into an issue.

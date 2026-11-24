## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How I verified it

<!-- Be specific: tests run, live smoke test, which agent / OS / shell.
     "It compiles" alone is not verification for protocol or agent changes. -->

## Checklist

- [ ] `npm run typecheck` is clean
- [ ] `npm run build` is clean
- [ ] `npm test` passes (and I added/updated tests for behavior changes)
- [ ] Docs updated where behavior changed (`README.md` / `docs/`), and a row
      added to the shipped table in `docs/status.md` if something shipped
- [ ] No secrets or session material committed (`session.json`,
      `storage_state.json`, `sessions-store.json`, `.env`, real tokens)
- [ ] If I touched a `.ps1` script: it is still pure ASCII (Windows
      PowerShell 5.1 requirement)
- [ ] If I touched a `.sh` script: it still works sourced in bash **and** zsh
- [ ] Error responses on any route I touched stay protocol-shaped
      (OpenAI / Anthropic envelopes, 400 for malformed bodies — never 500)

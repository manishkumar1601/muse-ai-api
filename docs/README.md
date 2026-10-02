# docs/

Reference material. Facts, diagrams, and recipes — not the chronological story (that's `memory/`).

## Index

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | How the pieces fit — browser, Noise, Hatch VM, our proxy |
| [wire-protocol.md](wire-protocol.md) | Noise handshake details, framing, chunking rules |
| [api-reference.md](api-reference.md) | Every discovered DAEMON endpoint with example requests/responses |
| [request-flow.md](request-flow.md) | Step-by-step walkthrough of one chat round-trip |
| [security.md](security.md) | Token lifecycle, what's stored where, what goes on the wire |
| [troubleshooting.md](troubleshooting.md) | Known errors + fixes (searchable error strings) |
| [openai-compat.md](openai-compat.md) | Pointing OpenAI SDKs / tools at the proxy |
| [anthropic-compat.md](anthropic-compat.md) | Pointing Anthropic SDKs / Claude Code at the proxy |
| [development.md](development.md) | How to extend: add endpoints, add events, re-probe, re-RE |
| [phases-overview.md](phases-overview.md) | What each phase of the project builds and why |

## Suggested reading order

**If you just want to use the proxy:** [phases-overview.md](phases-overview.md) → [anthropic-compat.md](anthropic-compat.md) or [openai-compat.md](openai-compat.md).

**If you want to understand how it works:** [architecture.md](architecture.md) → [wire-protocol.md](wire-protocol.md) → [request-flow.md](request-flow.md) → [api-reference.md](api-reference.md).

**If you want to extend it:** [development.md](development.md) → relevant memory/ entry for the phase you're touching.

**If something is broken:** [troubleshooting.md](troubleshooting.md).

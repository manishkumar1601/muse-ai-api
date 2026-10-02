# memory/

Dated session logs — one file per phase or significant chunk of work. Not reference material (that's `docs/`); these are the raw _story_ of how the project got built, what each session found out, what was tried and discarded, and what to remember when picking the work back up.

**File format:** `DD-MM-YYYY-topic-slug.md`
**Timezone used in file names:** IST (Asia/Calcutta).
**Ordering:** chronological by date and phase number.

## Index

| File | Phase | What |
|---|---|---|
| [01-10-2026-phase-0-recon.md](01-10-2026-phase-0-recon.md) | 0 | First look at muse.ai, decided Noise XX is reversible, mapped bootstrap endpoints |
| [01-10-2026-phase-1-bootstrap.md](01-10-2026-phase-1-bootstrap.md) | 1 | `bootstrap.py` — cookies → session.json → WS URL. Debugged TLS/UA fingerprinting |
| [02-10-2026-phase-2-noise-handshake.md](02-10-2026-phase-2-noise-handshake.md) | 2 | `handshake.py` — speak Noise XX end-to-end. First decrypted server frame |
| [02-10-2026-phase-3-route-discovery.md](02-10-2026-phase-3-route-discovery.md) | 3 | `sweep.py` — HTTP-over-Noise, enumerated 15+ live DAEMON routes |
| [02-10-2026-phase-4-chat-send.md](02-10-2026-phase-4-chat-send.md) | 4 | Found the human-chat endpoint by instrumenting browser's crypto.subtle |
| [02-10-2026-phase-5-streaming-reply.md](02-10-2026-phase-5-streaming-reply.md) | 5 | `/chat/subscribe` + `/client/register-capabilities` → full streamed reply |
| [02-10-2026-phase-7-openai-anthropic-proxy.md](02-10-2026-phase-7-openai-anthropic-proxy.md) | 7 | FastAPI proxy with both OpenAI and Anthropic wire formats |
| [02-10-2026-claude-code-integration-test.md](02-10-2026-claude-code-integration-test.md) | 7 | Pointed Claude Code at the proxy. Had to add chunking + count_tokens stub |

## How to use

- **After cloning on a new machine:** skim these in order to catch up on _why_ each design choice exists. The code tells you _what_; these tell you _why_, _what was tried first_, and _what was deliberately skipped_.
- **When something breaks:** search for the error string here first — most non-obvious errors are called out with the fix.
- **When starting a new phase:** add a new dated file; follow the same loose structure (goal → what I tried → what worked → gotchas → next).

## Convention

Each entry has roughly:

```
# Phase N — topic (DD-MM-YYYY)

## Goal
one sentence

## What I tried
chronological, including dead ends

## What worked
the final shape

## Gotchas (worth remembering)
numbered list — things that cost real debugging time

## Next
what's deliberately unfinished and what the next step would be
```

Keep each entry under ~300 lines. If a topic sprawls, split it into another dated file.

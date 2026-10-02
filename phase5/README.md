# Phase 5 — Streaming reply receipt

**No separate script lives here.** Phase 5 extended the Phase 4 chat client in-place rather than forking a new file. This folder exists only to make the project map match the phase numbering and to tell you where the code actually lives.

## Where the Phase 5 code is

All of Phase 5 lives in `../phase4/chat.py`. Specifically:

| What Phase 5 added | Function / location |
|---|---|
| Open a long-lived subscribe stream + register as push target | `send_and_collect_reply()` orchestrator — adds a `/client/register-capabilities` call and a `/chat/subscribe` call BEFORE `/chat/stream`. |
| Parse each `body_chunk` on the subscribe stream as a self-contained JSON event (don't wait for `end_body`) | `HatchClient._recv_one()` — the `kind == "body_chunk"` branch returns `(sid, "event", obj)` immediately when the data is valid JSON with an `event` key. |
| Filter catch-up events replayed by subscribe | `consume(sid, kind, obj)` callback inside `send_and_collect_reply()` — drops events with `ts_ms < send_start_ms`. |
| Pull the final assistant text out of `delta.message_done.payload.transcript` when no `delta.text_append` events fired | `extract_text_from_transcript()` inside `send_and_collect_reply()`. |
| Chunk large ServiceRequests across multiple NoiseTransportFrames | `HatchClient.request()` — splits at `MAX_CHUNK_PAYLOAD = 48KB`. (Added later during Phase 7 integration but belongs conceptually to the chat layer.) |

## Why it isn't its own script

Phase 5 is "same request, more plumbing" — it needed to add 2 calls before the Phase 4 `/chat/stream` call and 1 new frame-dispatch path to the Phase 4 recv loop. Splitting it off would mean either:

- a near-identical copy of `HatchClient` in `phase5/`, which rots when Phase 4 changes, or
- a thin subclass that overrides half the base class, which is harder to read than the merged version.

The merged version is 230 lines total; keeping it as one file in `phase4/` matched the lazy ladder (fewest files that work).

## Run it

Same as Phase 4:

```bash
cd phase4
python chat.py "say exactly: phase5-ok"
```

End of a successful run:
```
[end ] delta.message_done
--- reply (8 chars) ---
phase5-ok
```

## Full story

See [`../memory/02-10-2026-phase-5-streaming-reply.md`](../memory/02-10-2026-phase-5-streaming-reply.md) for the discovery path (how the subscribe mechanism was found + the 3 non-obvious gotchas that cost real debugging time).

See [`../docs/wire-protocol.md`](../docs/wire-protocol.md) §6-§8 for the event vocabulary and why `register-capabilities` is required.

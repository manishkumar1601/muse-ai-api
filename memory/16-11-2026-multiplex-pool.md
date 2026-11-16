# Multiplex-pool (16-11-2026)

## Goal

Upgrade the serialize-pool so concurrent `runChat` requests share one
`HatchClient` instead of queuing. Keep the ~500 ms handshake amortization
from the serialize-pool; stop blocking requests on each other's completion.

## What I tried

### HatchClient dispatcher

Replaced the public `recvOne(timeoutMs)` with `recvOne(sid, timeoutMs)`. The
old global drain-then-filter pattern leaked events across concurrent callers
— caller A would pop caller B's event, filter by its own `sendSid`, drop it.
Event lost to B forever.

New internal design:

- `_processOneRaw()` — same code as the old `recvOne` but only called by
  the dispatcher. Reads next ws frame, decrypts, reassembles chunks, parses
  `ServiceFrame`, returns `{kind, streamId, ...}`.
- `_runDispatcher()` — background task started on first `recvOne` call.
  Loops `_processOneRaw`, routes each event to `_streamQueues.get(sid)`
  or wakes a pending `_streamWaiters.get(sid)` entry.
- `recvOne(sid, timeoutMs)` — if the per-sid queue has an event, return it;
  else register a waiter with a timeout, let the dispatcher wake it.

On ws close, dispatcher exits and wakes all pending waiters with `"closed"`.

### sendAndCollectReply

Main-chat path used to loop one `recvOne()` and switch on `r.streamId ===
sendSid` for acks vs events. Now:

- Spawns a background `ackP` task: `recvOne(sendSid, 60_000)` until a
  `complete` arrives, extract `message_id`.
- Main loop calls `recvOne(subscribeSid)` for events — no cross-stream
  filtering needed, the dispatcher has already routed.
- `await ackP` before returning so late acks don't leak.

Side-chat path's ack wait + poll loops both switched to sid-targeted
`recvOne`.

### Pool

Removed the FIFO mutex. Kept the lazy-open mutex so concurrent first-callers
don't race to open two clients. `withClient` now:

1. `getClient()` — resolves to the cached `current` or awaits the shared
   `opening` promise.
2. Runs `fn(client)` — concurrent callers overlap here.
3. On throw, close + null the client if we're still the owner; other
   in-flight callers surface `"closed"` from their `recvOne` and fall
   through to the handler's bootstrap retry.

### Tests

- Updated `tests/chat.test.ts` mock to be sid-aware (per-sid queue keyed by
  the fired path).
- Added `tests/pool.test.ts` tests: concurrent `withClient` overlaps (not
  serialized), concurrent first-call race opens exactly one client.
- Existing 80 tests continue to pass (71 original + 9 added across the
  November batch).

## Gotchas (worth remembering)

1. **Dispatcher starts lazily.** It's not started in the constructor
   because the handshake kick-frame is sent before any `recvOne`. Starting
   it earlier could race the kick's AEAD tag write.
2. **Timeout on recvOne is per-call.** A 1500 ms timeout returns `null` so
   the caller can loop and re-check deadlines / abort signals. This is
   intentional — callers set their own long deadlines, polling pattern
   stays the same.
3. **Fault isolation is partial.** One concurrent request erroring out
   closes the shared client. Other in-flight requests see `"closed"` and
   error too. They retry via the handler's bootstrap path. Not a perfect
   bulkhead; good enough for a dev proxy.
4. **Main-chat subscribe accumulates.** Each call still issues
   `/chat/subscribe` + `/client/register-capabilities`. With multiplex, two
   concurrent main-chat calls → two subscribe streams on the server at
   once. Unknown if muse caps that. If complaints come in, move subscribe
   into `openClient()` and have all callers share one subscribe stream.
5. **Node's microtask ordering.** The ack-waiter is `(async () => {...})()`
   — fired and awaited later. Dispatcher must have started by then; the
   first `recvOne(sendSid, ...)` inside the IIFE triggers
   `_ensureDispatcher`. Race-free because `recvOne` is sync up to the
   `await _dequeueWithTimeout`.

## What's next

- Attestation chain verification (Phase 8) — still the biggest structural
  gap. Needs `attestation_bundle.proto` walked + ed25519 chain validation
  against the notary CA key. 1-2 days once a sample msg2 is captured.
- A hard-fault bulkhead if one client ever gets more than a few concurrent
  callers and transient errors start taking out neighbors. Not an issue
  today.

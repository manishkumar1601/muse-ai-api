# Side-chat routing (05-10-2026)

## Goal

Route each API session (identified by `X-Muse-Session` header, or hash of `Authorization` bearer) to its own dedicated side chat on muse.ai, instead of everyone piling into main. First call creates the thread; subsequent calls continue it. No header → main chat (backward compatible).

## What I tried (chronological, including dead ends)

### Dead end 1 — echo `session_id` back from ack

Observed that `/chat/stream` ack returned `{channel, session_id, is_thread}`. Hypothesis: cache session_id per API key, pass back on next call. Shipped it, tests passed, pushed to master.

Live smoke test: both "sessions" ended up in main chat because the ack's `session_id` was always the main chat's. The ack echoes muse's view of the thread, not our choice. **Wrong model entirely.**

### Correct model (reverse-engineered from browser capture)

Clicked "Side chats +" in the muse.ai sidebar with `crypto.subtle` instrumented. The browser:

1. Pre-generated a UUID client-side (navigated to `/thread/<UUID>`).
2. Sent `POST /chat/stream` with `{..., session_id: "<that UUID>", metadata: {thread_is_dictation_used: false}}`.
3. Server created the thread under that UUID.

**Insight:** `session_id` in request body IS the thread id, chosen by the client, not assigned by the server. First use creates, subsequent uses continue.

### Dead end 2 — session_id alone wasn't enough

Added `session_id` to request body. Live test: side chats appeared in muse's sidebar (good — thread creation worked), but the proxy never received the assistant reply (bad — 60s timeout, empty text).

X2 (continuing an existing thread) worked, but X1 (first message creating one) didn't. Reply events never reached our scoped subscribe stream for a thread that didn't exist at subscribe time.

### Dead end 3 — subscribe ordering

Tried subscribe-first-then-send, send-first-then-subscribe, global subscribe (no session_id), scoped subscribe (with session_id). All combinations failed for first messages, worked for continuing.

### Dead end 4 — both subscribes concurrently

Opened `/chat/subscribe` twice (one global, one scoped). Still no deltas for first-message replies.

### The missing endpoint — `/api/nodes/register`

Grepped the browser capture for ALL requests, found `POST /api/nodes/register` with `{node_id, display_name, platform, commands_v2:{ping:{description:...}}}`. Added it as a fire-and-forget before register-capabilities. Still didn't fix first-message replies on its own, but it IS required (removing it later confirmed the degradation).

### The actual fix — `/chat/history` fallback

The browser capture also showed `GET /chat/history?limit=40&transcript_mode=messages&session_id=<UUID>` — returns the full event log for a thread. Response:
```json
{"ok": true, "result": {"channel": "all", "chat_events": [
  {"event_name": "message.user",      "display_text": "...",       "message_id": "...", "seq": 278},
  {"event_name": "message.assistant", "display_text": "SIDE-X-OK", "message_id": "assistant-msg-...", "seq": 279}
]}}
```

Added `fetchAssistantReplyFromHistory()` in `src/hatch/chat.ts`: after a side-chat message's `/chat/stream` ack with no WS deltas, poll `/chat/history` every 500ms until a `message.assistant` entry appears after our sent `message_id`. Works reliably because the stored reply is always retrievable even if the WS deltas were lost.

Live smoke test: X1="SIDE-X-OK", Y1="SIDE-Y-OK", X2 recalled X's prior history (not Y's). Verified visually in muse.ai sidebar — two separate side chats, each with correct user message + correct assistant reply.

## Gotchas (worth remembering)

1. **`session_id` is client-chosen, not server-assigned.** The browser pre-generates a UUID and sends it in `/chat/stream`. Don't try to extract it from the ack and echo it — the ack gives you the SAME-main-chat session_id if you didn't send one.

2. **`node_id` must be stable across all three endpoints** for the same API session: `/api/nodes/register.node_id`, `/client/register-capabilities.client_id`, `/chat/stream.node_id`. Muse routes thread events to that identity. If you rotate node_id per call, continuing-thread deltas still arrive (because thread already exists on server, muse figures it out) but first-message replies get lost.

3. **Scoped subscribe (`session_id` in body) only works for threads muse already knows about.** For a brand-new thread, subscribe-first-then-send and send-first-then-subscribe both lose the first reply because there's no stable moment where "thread exists AND we're subscribed." Give up on WS for first messages; use history poll.

4. **`/api/nodes/register` is non-obvious but required.** No field in `/client/register-capabilities` is a substitute. Without it, muse treats your node as unknown and events get dropped silently (not errored).

5. **The ack `session_id` field is a red herring.** It tells you which chat the message landed in, not what to pass back. If you want a specific side chat, YOU pick the UUID and pass it; muse accepts your choice.

6. **cycletls parses JSON responses automatically**, so `resp.body` may already be an object (`.slice is not a function` error). Guard with `typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body`. Fixed in `src/bootstrap/session.ts`.

## Session-store design (`src/hatch/sessions.ts`)

In-memory `Map<key, {sessionId, nodeId, lastUsed}>`. 24h sliding TTL, LRU eviction at 1000 entries. Both IDs minted once per key, reused forever (until TTL expires).

Session key derivation:
- `X-Muse-Session: <value>` present → `h:<value>`
- else `Authorization: Bearer <token>` present → `a:<sha256-16-hex>` of the whole header
- else → `default` (goes to main chat, no `session_id` sent)

The `default` case explicitly skips `SessionStore.get()` so it stays identical to the pre-side-chat behavior for callers that don't opt in.

## Next

- (optional) In-memory history poll could be smarter: track seq numbers so we only poll `after_chat_event_seq=<our-send-seq>` and avoid pulling 40 messages each time.
- (optional) Persist SessionStore to disk so sessions survive proxy restarts. Current in-process TTL means a restart loses mappings — session keys get new sessionIds, start new threads.
- Side-chat deletion / archive not implemented. Browser has `POST /api/chat/<id>` with DELETE semantics but we never need this.

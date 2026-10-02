# Phase 4 — Find and reproduce the human-chat send (02-10-2026)

## Goal

Figure out what HTTP call the browser makes when a user types a message, so we can replicate it from Python.

## What I tried

1. **Grepped the JS for `/chat/*`, `kind:"user"`, verb+path literals** — found exactly ONE path literal: `/v1/noise`. All API paths are built dynamically or minified beyond simple regex.
2. **Grepped for dotted route names** (e.g. `hatch.message.user_send`) — found ~100. But these are TELEMETRY / trace policy names, not HTTP paths. Dead end for route discovery.
3. **Monkey-patched `crypto.subtle.encrypt`/`decrypt`** via `page.addInitScript` so I'd see plaintext of every Noise frame before encryption. Reloaded muse.ai, typed `PHASE4-MARKER-HELLO` into the chat.
4. **Grepped the hex log for `504841534534` (PHASE4 ASCII in hex)** — found exactly one encrypted frame containing it. Decoded as:
   ```
   NoiseTransportFrame { chunk_id, chunk_index, total_chunks=1, payload:
     ServiceRequest { service=DAEMON (default), payload:
       ServiceFrame { stream_id, request:
         ApplicationRequest {
           verb: "POST", path: "/chat/stream",
           headers: [content-type: application/json, accept-language: en-US],
           body: {"message":"PHASE4-MARKER-HELLO","node_id":"3d4d18af-...","capabilities":[...],"timezone":"Asia/Calcutta"},
           end_body: true,
         }
       }
     }
   }
   ```
   **The real path is `POST /chat/stream`.** Phase 3's `GET /chat/stream` 403 was a verb-check — the ACL distinguishes GET vs POST on the same path.
5. **Replicated POST /chat/stream from Python** with the discovered body shape → **200 OK with reply_to_message_id**. Verified in Playwright that the agent actually replied in the browser's chat log:
   ```
   You: hi from phase4 reverse-engineered client
   Hi back to the phase4 client — connection's working.
   ```

## What worked

- **Monkey-patching `crypto.subtle`** at init-script scope catches plaintexts for both main thread and worker. Lookup table: ASCII marker → hex → grep. Works for any encrypted protocol as long as crypto is done in the browser.
- Body shape for human chat:
  ```json
  POST /chat/stream   (SERVICE_DAEMON)
  Content-Type: application/json
  {
    "message":      "<user text>",
    "node_id":      "<fresh uuid>",
    "capabilities": ["chat_cancel", "delta_stream", "custom_reactions"],
    "timezone":     "<IANA, e.g. Asia/Calcutta>"
  }
  ```
- Sync ack body: `{channel, is_thread, message_id, reply_to_message_id, session_id}`.
- The message routes to the real agent and the reply appears in the normal chat UI — this is NOT a sandboxed test endpoint, it's the actual production chat flow.

## Gotchas (worth remembering)

1. **Grep for path literals fails against bufbuild/webpack bundles.** Paths are dynamic. Instrument crypto instead and let the user drive the UI.
2. **Verb-per-path ACLs.** Same path, different verbs = different ACLs. Always try both GET and POST.
3. **`kind=user` is server-side-rejected over noise.** You'd think the obvious knob but no — human messages take a different path (`/chat/stream`), not a different kind on `/chat/send`.
4. **The streaming reply doesn't come to the connection that sent the POST.** Server pushes to the browser's existing noise connection even if we close ours. Phase 5 problem.
5. **node_id in the browser trace is a fresh UUID per message**, not a persistent conversation id. Server returns its own `message_id` in the ack.

## Deliverables

`phase4/chat.py` v1 — sends the human chat message, returns the sync ack. Streaming reply not yet captured.

## Next

Phase 5: find the subscription endpoint that registers us as the push target for streamed events.

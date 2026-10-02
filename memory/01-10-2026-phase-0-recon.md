# Phase 0 — Recon (01-10-2026)

## Goal

Figure out if a muse.ai web2api proxy (like `gemini-web2api`) is possible, and what the actual wire protocol is.

## What I tried

1. **Playwright capture.** Logged in to muse.ai, sent a message, watched the network tab. HTTP requests all went to `muse.ai/api/*` (session cookies, telemetry). The actual chat messages didn't appear in `browser_network_requests` output — Playwright's HTTP network listing doesn't surface WebSocket frames.
2. **Monkey-patched `window.WebSocket`** via `page.evaluate` after page load — logged nothing, because the WebSocket is opened in a Web Worker before my patch ran.
3. **Switched to `page.addInitScript` + `browser_run_code_unsafe`** to inject the WebSocket wrapper _before_ any script executes. First frame captured: `wss://hatch.metaaivm.com/v1/noise?vm_id=&auth_token=&notary_token=&app_id=hatch-web&request_id=`.
4. **Downloaded all 212 Next.js chunks** from `muse.ai/_next/static/chunks/`, grepped for `Noise_`, `fileDesc`, `ServiceType`, `/api/hatch/`. Found exact Noise suite string + 5 embedded `FileDescriptorProto` blobs.

## What worked

- Noise suite is literally `Noise_XX_25519_AESGCM_SHA256` — stdlib, any Noise lib speaks it.
- Bootstrap flow: 4 POSTs on muse.ai with session cookies → one WS to `hatch.metaaivm.com/v1/noise`.
  1. `POST /api/hatch/vm/wake` — provisions per-user VM
  2. `POST /api/hatch/lease-vm` — leases a VM slot
  3. `POST /api/hatch/token` — gets short-lived EdDSA JWT
  4. `POST /api/hatch/noise-notary-token` — gets server-key attestation
- Transport is HTTP-over-Noise. ServiceFrame.ApplicationRequest carries verb/path/headers/body, server replies with ApplicationResponse + body_chunks on the same stream_id.

## Gotchas (worth remembering)

1. **WebSocket frames are invisible to Playwright's `browser_network_requests`.** Use crypto/WS monkey-patching instead.
2. **Monkey-patching after page load misses workers.** `page.addInitScript` is the only way to catch frames before scripts run.
3. **Only 5 protobuf descriptors are embedded via `fileDesc("<base64>")`** (noise_transport, noise_envelope, attestation_bundle, plexi_types, revocation_list). The rest of the app schemas use JSON over HTTP-over-Noise — no need to AST-extract bufbuild-es generated code.
4. The notary token endorses the **server's static Noise key**, not the client's. Client generates its own ephemeral + static per handshake.

## Deliverables

`recon/`:
- `chunks/` — 9 highest-signal JS chunks saved verbatim
- `chunk_urls.txt` — all 212 URLs
- `signal_summary.json` — grep hits across the full bundle
- `proto_catalog.json` — descriptor finds
- `PHASE_0_REPORT.md` — the full writeup

## Next

Phase 1: `bootstrap.py` that reads cookies, hits the 4 endpoints in order, produces `session.json` with a Noise WS URL ready for Phase 2.

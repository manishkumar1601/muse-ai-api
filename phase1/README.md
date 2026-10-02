# Phase 1 — bootstrap muse.ai (Hatch) session to the point of Noise handshake

Takes a logged-in `muse.ai` browser session and produces every piece of state
needed to open the Noise WebSocket to Meta's Hatch VM. Stops **before** the
crypto starts — that's Phase 2.

**Output:** `session.json` with `vm_id`, `gateway_url`, `auth_token`,
`notary_token`, and a fully-built `ws_url` ready for a Noise client.

## Prereq

1. Python 3.10+ (uses `|` type hints)
2. `pip install -r requirements.txt` — pulls in `curl_cffi` (needed for Chrome TLS/H2 impersonation; stock `requests` + `urllib3` get 403'd)
3. A `storage_state.json` captured from a logged-in muse.ai session.

### How to capture `storage_state.json`

With Playwright (any language). Via the Playwright CLI, inspector, or your own script after logging in:
```js
await page.context().storageState({ path: 'storage_state.json' });
```

The file is Playwright's standard storage-state format (`{ cookies: [...], origins: [...] }`); we only read `cookies` with domain containing `muse.ai`. The one cookie we *require* is `hatch_sess`.

## Run

```bash
python bootstrap.py                  # defaults: storage_state.json -> session.json
python bootstrap.py --verbose        # dump each request + response
python bootstrap.py --self-check     # offline unit tests on URL building, no network
```

With a fresh session it does up to 5 HTTP calls:

| Step | Path | Body | Returns |
|---|---|---|---|
| 1a | `/api/hatch/lease-vm` (if no existing VM) | `{"vmType":"standard"}` | `{status:"assigned", gatewayUrl, vmName}` |
| 1b | `GET /` (fallback if 1a is 403) | — | parses `activeGatewayUrl` from Hatch SSR state |
| 2 | `/api/hatch/vm/wake` | `{"vm_id":"...","retry_count":0}` | `{"status":"wake_requested"}` |
| 3 | `/api/hatch/token` | `{"vmAddress":"wss://...","vmName":"..."}` | `{token, notary_token}` |
| 4 | `/api/hatch/noise-notary-token` | `{"vmName":"..."}` | `{notaryToken}` |

Once your account has an assigned VM, `lease-vm` returns 403 and we auto-fall-back to scraping the HTML — this is normal. To skip even that round-trip, pass `--vm-id` + `--gateway-url` from a previous `session.json`.

## Why `curl_cffi` and not `requests`

Hatch's edge rejects Python's stock TLS/HTTP-2 fingerprint with a bare `{"error":"Forbidden"}` on any authenticated route. `curl_cffi` with `impersonate="chrome"` makes libcurl present Chrome's JA3/JA4 + H2 SETTINGS, which gets through. We also pin `User-Agent`, `sec-ch-ua`, `sec-ch-ua-platform` to match the browser that minted the session cookie (default is macOS Chrome 150; we need Windows Chrome 154).

If you captured your `hatch_sess` from a different browser/OS, update the `UA` and `sec-ch-ua*` constants in `bootstrap.py` to match that browser — otherwise `/api/hatch/vm/wake` will 403 even with valid cookies.

## What's in `session.json`

```json
{
  "vm_id": "3574599d-879f-...",
  "gateway_url": "wss://<vm_id>.metaaivm.com/",
  "auth_token": "s0:eyJ...<JWT>",
  "notary_token": "endorsement.v1.<base64>.<sig>.<uri>.<sig2>",
  "ws_url": "wss://hatch.metaaivm.com/v1/noise?vm_id=&auth_token=&notary_token=&app_id=hatch-web&request_id=",
  "noise_suite": "Noise_XX_25519_AESGCM_SHA256"
}
```

Feed `ws_url` to any WebSocket client. Opening it will trigger the Noise XX handshake — which bootstrap.py doesn't do. See `../recon/PHASE_0_REPORT.md` section 5 for the handshake details Phase 2 will implement.

## Security

- `storage_state.json` and `session.json` contain long-lived session cookies and short-lived VM admission tokens respectively. Both are in `.gitignore`. Don't commit, don't paste.
- Tokens are time-limited (observed: ~20h for both `auth_token` and `notary_token`). Rerun bootstrap.py when they expire — the HTTP steps all re-mint fresh tokens, the cookies are the only long-lived piece.
- The script only exercises your own authenticated Meta session. Nothing here that Chrome DevTools can't already see.

## Known not-handled

- 2FA / login flow — assumes `storage_state.json` is already authenticated.
- CVM / recovery key paths (`readCvmRecoveryKey` in `recon/chunks/1dva5p6eh25ps.js`). Only matters for "confidential" VMs; standard chat sessions don't need it.
- `atod_token` / `use_od=1` — developer test routing, not emitted by production clients.

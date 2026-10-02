# Phase 1 — bootstrap.py (01-10-2026)

## Goal

Take logged-in browser cookies and produce `session.json` with everything a Noise client needs (vm_id, auth_token, notary_token, fully-built ws_url).

## What I tried

1. **Dumped cookies via Playwright** — `page.context().storageState({ path: 'storage_state.json' })`. Clean, no DPAPI dance.
2. **Wrote `bootstrap.py` with `requests`** — hit `/api/hatch/vm/wake` with the standard headers (UA, Origin, Referer, Content-Type). Got **403 Forbidden** on every authenticated endpoint. Public ones (`/api/client-ip`, `/api/consent/status`) returned 200.
3. **Suspected TLS/JA3 fingerprinting.** Swapped `requests` → `curl_cffi` with `impersonate="chrome"`. Still 403.
4. **Checked what curl_cffi actually sent** by hitting httpbin — saw it sends macOS Chrome 150 UA by default. Our cookie was minted by Windows Chrome 154. Server appears to bind session to UA.
5. **Overrode UA + sec-ch-ua + sec-ch-ua-platform** to Windows Chrome 154 explicitly. **200 OK on every endpoint.**

## What worked

- `curl_cffi.Session(impersonate="chrome")` for TLS/H2 fingerprint, **plus** explicit header overrides:
  ```
  User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
              AppleWebKit/537.36 (KHTML, like Gecko)
              Chrome/154.0.0.0 Safari/537.36
  sec-ch-ua: "Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"
  sec-ch-ua-mobile: ?0
  sec-ch-ua-platform: "Windows"
  ```
- `lease-vm` 403s once an account already has a VM assigned; fall back to scraping `activeGatewayUrl` out of the SSR HTML on `GET /`.
- Request bodies (empirically confirmed working):
  ```
  POST /api/hatch/lease-vm            {"vmType": "standard"}
  POST /api/hatch/vm/wake             {"vm_id": "<uuid>", "retry_count": 0}
  POST /api/hatch/token               {"vmAddress": "<wss url>", "vmName": "<uuid>"}
  POST /api/hatch/noise-notary-token  {"vmName": "<uuid>"}
  ```
- Response for `/token` uses snake_case (`notary_token`), response for `/noise-notary-token` uses camelCase (`notaryToken`). Don't typo this.

## Gotchas (worth remembering)

1. **Session cookies are bound to UA** — `curl_cffi`'s default UA is macOS Chrome 150, not Windows Chrome 154. If the UA doesn't match the one that minted the cookie, every authenticated endpoint 403s even with Chrome TLS impersonation. Override `User-Agent` and `sec-ch-ua*` headers.
2. **lease-vm is only usable the first time.** Second call for an account that already has a VM returns 403. Fall back to scraping `window.__hatchEarlyGatewayRuntimeState.activeGatewayUrl` out of the SSR'd HTML.
3. **Notary pubkey ≠ server static Noise key.** It's a CA/root key; the actual VM static arrives inside msg2 of the handshake with an attestation chain in the sub-message. Our comparison code logs this mismatch but doesn't treat it as fatal.

## Deliverables

`phase1/`:
- `bootstrap.py` — 220 lines, one script, emits `session.json` + an auto-rebootstrap helper for Phase 7
- `requirements.txt` — `curl_cffi>=0.7`
- `.gitignore` — session.json, storage_state.json, cookies.json
- `README.md` — run instructions

## Next

Phase 2: Noise XX handshake against the ws_url, dump decrypted frames.

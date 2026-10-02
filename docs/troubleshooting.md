# Troubleshooting

Searchable by error string.

## HTTP 403 `{"error":"Forbidden"}` on `/api/hatch/*`

**Cause:** TLS or UA fingerprint mismatch. Session cookies are bound to the browser (User-Agent + sec-ch-ua) that minted them.

**Fix:** Make sure `phase1/bootstrap.py` uses `curl_cffi.Session(impersonate="chrome")` _and_ overrides headers to match your capturing browser:
```python
s.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ... Chrome/154.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
})
```
If you captured cookies from a different OS or Chrome version, update the UA strings to match that browser.

## HTTP 403 `{"error":"Forbidden"}` on `/api/hatch/lease-vm`

**Cause:** Your account already has a VM assigned.

**Fix:** This is expected after the first bootstrap. Our code auto-falls-back to parsing `activeGatewayUrl` from the SSR HTML of `GET /`. If that also fails, pass `--vm-id` + `--gateway-url` manually (grab them in DevTools: `window.__hatchEarlyGatewayRuntimeState.activeGatewayUrl`).

## WS upgrade 401 Unauthorized

**Cause:** Same TLS/UA fingerprint issue as above, but on the WebSocket handshake. Also, your `auth_token` may have expired.

**Fix:** Make sure Phase 2/4/7 code uses `curl_cffi.Session.ws_connect(...)` (not `websocket-client` or `websockets`). If still 401, rerun `python phase1/bootstrap.py` to mint fresh tokens.

## `curl_cffi.curl.CurlError: Failed to WS_RECV, curl: (56) BoringSSL SSL_read: ... SSLV3_ALERT_CLOSE_NOTIFY`

The Noise WebSocket was closed by the server. Several possible causes:

1. **msg1 payload wrong.** Must be exactly 34 bytes: `0x0a 0x20 <32 CSPRNG bytes>`. See `docs/wire-protocol.md` §2.
2. **No `/client/register-capabilities` before `/chat/subscribe`.** Server disconnects idle initiators that don't register.
3. **ServiceRequest payload too large.** Server rejects any single `NoiseTransportFrame.payload` over 65535 bytes. Our `HatchClient.request()` auto-chunks at 48KB. If you removed that chunking, add it back.
4. **auth_token / notary_token expired mid-session.** Rerun bootstrap.

## `curl_cffi.curl.CurlError: Failed to WS_RECV, curl: (28) Operation timed out`

Normal — curl's per-op timeout fired (we set `TIMEOUT_MS = 1500-2000`). The outer loop will retry. If it keeps happening after a reasonable listen window, the server has gone silent.

## Chat `/chat/send` returns 400 `"must provide 'message' or non-empty 'items'"`

You sent an empty body. See `docs/api-reference.md` for the full accepted shape, or just hit `/chat/stream` instead (that's the human-chat path).

## Chat `/chat/send` returns 400 `"chat.send over the local HTTP API requires 'kind=action'"`

You tried `kind=user` on `/chat/send`. That path is for agent action invocations only. For human chat use `POST /chat/stream` instead.

## Chat `/chat/stream` returns 403 `"matched route missing from endpoint ACL"`

You used verb `GET`. Use `POST`.

## No streaming events arrive after `/chat/stream` returns 200

**Likely cause:** You forgot `/client/register-capabilities` before `/chat/subscribe`. The server routes pushed events to whichever `client_id` was last registered — probably your open browser tab.

**Fix:** Call `register-capabilities` with a fresh UUID, then `/chat/subscribe`, then pass the SAME UUID as `node_id` in `/chat/stream`. See `docs/wire-protocol.md` §8.

## Streaming events arrive but all have old timestamps

`/chat/subscribe` replays catch-up events after `after_chat_event_seq`. If you pass `0`, you get everything. **Filter in the client** by `ts_ms < send_start_ms` to drop replay.

## Claude Code hangs on first message

**Cause:** Claude Code probes `/v1/messages/count_tokens` before every send. If the proxy returns 404, Claude Code hangs.

**Fix:** Our Phase 7 server already includes a stub. If you forked and removed it, add it back:
```python
@app.post("/v1/messages/count_tokens")
async def count_tokens(req: Request):
    return {"input_tokens": 1}
```

## Claude Code gets BoringSSL CLOSE_NOTIFY

Claude Code sends a large system prompt + MCP tools context (often >50KB). The Noise transport caps at 65KB per frame. Make sure `HatchClient.request()` has the chunking logic:
```python
parts = [sr_bytes[i:i + self.MAX_CHUNK_PAYLOAD] for i in range(0, len(sr_bytes) or 1, self.MAX_CHUNK_PAYLOAD)]
```

## PowerShell: `The '<' operator is reserved for future use.`

PowerShell doesn't support `<` for stdin redirection. Use `"" | claude ...` to pipe empty stdin, or `cmd /c "claude -p '...' < nul"`.

## `python chat.py "/path"` sends `C:/Program Files/Git/`

Git Bash expands bare `/` to the MSYS root. Use PowerShell for probes with path arguments, or quote carefully.

## `curl_cffi` default UA is macOS Chrome 150

`impersonate="chrome"` sets Chrome TLS fingerprint but macOS UA. Our code overrides to Windows Chrome 154 explicitly. If you captured cookies from macOS, change the UA to match your actual browser or you'll 403.

## Our subscribe stream parses the first server response as an event and fails

The subscribe endpoint's first frame is a `response` (HTTP 200), not a `body_chunk`. Our `_recv_one` handles both; make sure you didn't accidentally treat `response` frames as JSON events.

## session.json works for 5 minutes then everything 401s

Normal — the EdDSA auth_token has a short TTL. Rerun `python phase1/bootstrap.py` or let the Phase 7 server auto-rebootstrap (it tries once on first failure).

## `ssh git@github.com: Permission denied (publickey)` when pushing

Your SSH key isn't in the agent / isn't registered on the GitHub account. Verify with:
```bash
ssh -T -i ~/.ssh/<keyname> -o IdentitiesOnly=yes git@github.com
```
Should print `Hi <github-username>! You've successfully authenticated...`. If not, add the pubkey to the account at github.com/settings/keys.

Our SSH config fix for this repo (if you have `manish-pg` host alias): the `User` field in `~/.ssh/config` must be `git` (not the GitHub username). GitHub's SSH service always logs in as `git`; the key identifies the account.

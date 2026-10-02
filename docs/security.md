# Security & secrets

## What is sensitive, where it lives, what happens if it leaks

| Thing | Where it lives | Risk if leaked | Rotate how |
|---|---|---|---|
| muse.ai session cookies (`hatch_sess`, `hatch_vml`, `hatch_gw`, etc.) | `./storage_state.json` | **Full account access.** Anyone with these cookies can read/send everything your Muse account can, as you. | Log out of muse.ai in the browser, log back in, re-dump storage_state. |
| EdDSA JWT auth_token | `./session.json` | VM admission for a few hours. Lets someone open the Noise WS as your VM. | Expires naturally. Rerun `npm run bootstrap` to mint a new one. |
| notary_token | `./session.json` | Pairs with auth_token for the same window. | Same as above. |
| vm_id | `./session.json` | Low — identifies which VM you own. Not useful alone. | Changes when the server reassigns your VM. |
| MUSE_PROXY_KEY (optional) | env var at proxy startup | Lets anyone talk to your running proxy, which uses the above tokens. | Change the env var, restart. |
| SSH keys | `~/.ssh/*` (not in this repo) | — | Not touched by this project. |

All of the above except SSH keys are in `.gitignore`. **Never commit them.** The commit history should be auditable from a public fork.

## What is NOT a secret

- The 9 saved JS chunks under `recon/chunks/`. These are Meta's publicly served minified JS; anyone can download them. **However**, redistributing them might trip DMCA notices. We ship them for reproducibility; a hygienic fork would delete them and re-fetch from `recon/chunk_urls.txt`.
- The 5 extracted protobuf descriptors under `src/proto/schemas/`. Also derived from the public JS.
- Any TypeScript code in this repo. Original work.

## Noise crypto hygiene

- Client X25519 keypair is generated **per handshake** via `@noble/curves` `x25519.utils.randomPrivateKey()`. Nothing persistent on our end.
- The 32-byte client nonce in msg1 is CSPRNG per handshake (`randomBytes(32)` from Node `crypto`). Not reused.
- AES-GCM nonces are counter-based per cipher state, per Noise spec. Never reuse a key between runs.
- We do **not** persist any session keys to disk. Only the HTTP tokens from `/api/hatch/token` and `/api/hatch/noise-notary-token` get written to `session.json`.

## Attestation (currently not verified)

Our client logs `server_pub_matches_notary: false` on every run. This is **expected**:

- `notary_token.public_key.key` is a CA/root key.
- The actual VM Noise static key arrives inside the decrypted msg2 payload, along with an attestation chain.
- Full verification would require parsing `src/proto/schemas/attestation_bundle.proto.binpb` and verifying signatures against the notary CA.

Not verifying leaves us open to a MITM between us and `hatch.metaaivm.com`. Mitigations in practice:
- TLS from the Node HTTP stack (cycletls for authenticated HTTP calls) pins the server cert chain via standard CA roots.
- `hatch.metaaivm.com` is a Meta-controlled host; a MITM requires compromising their TLS infra, not just their Noise layer.

If you want to add attestation verification, that's a Phase 8 task.

## Proxy exposure

Default: `--host 127.0.0.1`. Localhost only, no network exposure.

If you want to serve the proxy to other machines:
1. Set `MUSE_PROXY_KEY=<long random string>` so random port scanners can't hit it.
2. Put it behind a real TLS terminator (nginx / caddy / cloudflare tunnel).
3. Consider: everyone who talks to the proxy is effectively using **your** muse.ai account.

## What goes over the wire

| Hop | What's visible to a passive observer |
|---|---|
| Browser/Node → muse.ai | TLS. Observer sees TLS SNI, timing, byte counts. |
| Browser/Node → hatch.metaaivm.com | TLS + WebSocket. Observer sees SNI, URL path, query (auth_token + notary_token are in the query — **don't paste the ws_url anywhere**). |
| Noise frames (inside WS) | AES-GCM encrypted. Observer sees ciphertext lengths. |

The `ws_url` in `session.json` contains both tokens inline. **Never share it.**

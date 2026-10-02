# Phase 0 Recon — muse.ai (Hatch) web-chat protocol

Captured 2026-10-01 against `https://muse.ai/` (logged-in session).
Downloaded 210 of 212 Next.js chunks (~9.5 MB total), grepped for Noise / protobuf / gateway signals.

Working directory: `C:\Users\DESK0034\Documents\muse-ai-api\recon\`
- `chunks/` — the 9 highest-signal JS chunks saved verbatim
- `proto_descriptors/` — any protobuf `boot()` descriptors extracted
- `signal_summary.json` — full grep output across all 210 chunks
- `proto_catalog.json` — descriptor + string-find catalog for key chunks
- `chunk_urls.txt` — original URL list

---

## 1. Noise suite — fully determined

**Pattern:** `Noise_XX_25519_AESGCM_SHA256`
- Source: `chunks/1w9duffuzanuc.js`, exact string literal passed as the Noise `h` initializer:
  ```
  let e = new TextEncoder().encode("Noise_XX_25519_AESGCM_SHA256")
  ```
- `XX`: mutual authentication, 3 handshake messages.
- Primitives: X25519 DH + AES-GCM AEAD + SHA-256 hash.
- Browser X25519 via `libsodium` (fallback error: `"This browser cannot initialize compatible X25519 implementation"`).
- AES-GCM + SHA-256 via WebCrypto (`globalThis.crypto.subtle`).

**Frame sizes captured on the wire match XX exactly:**
- send #1 = 66 B → `-> e` (32 B ephemeral pubkey + ~34 B framing / empty encrypted payload)
- recv #1 = 64 B (not captured in this report, but visible in live run) → `<- e, ee, s, es`
- send #2 = 210 B → `-> s, se` with first encrypted app payload
- Everything after is encrypted transport messages (ArrayBuffer, 160 recv + 43 send in one turn).

**Implication:** any stock Noise library (Rust `snow`, Python `dissononce` / `noise-protocol`, Go `flynn/noise`, JS `@chainsafe/libp2p-noise`) can speak this handshake. No custom cipher, no custom pattern. Day of work to echo frames.

---

## 2. Noise identity + endorsement — reproducible

The browser generates a per-session X25519 keypair (libsodium `crypto_kx_keypair`-style), then POSTs its public key to:

```
POST /api/hatch/noise-notary-token    (muse.ai session cookies)
```

Source: `chunks/1w9duffuzanuc.js`, `async function j(e) { ... fetch("/api/hatch/noise-notary-token", ...) }`.

The server returns the `notary_token` we captured earlier:
```
endorsement.v1.<base64-restrictions>.<base64-pubkey>.<base64-signature>.<base64-uri>.<base64-sig2>
```
Format: `endorsement.v1.<payload>.<server-sig>.<uri-binding>.<uri-sig>`. The payload encodes:
- `restrictions`: `timeout:<unix>`, `hostname:<vm-id>.metaaivm.com`, `uri-handle-prefix:/v1/noise`
- `identity`: Meta user ID (`"1364572556736785"` in our capture)
- `public_key`: the client's Ed25519 pubkey (X25519→Ed25519 is a 1:1 derivation for this purpose)

So the Noise static key is bound to the Meta account via a server-signed endorsement. To speak the protocol: generate X25519, POST pubkey to `/api/hatch/noise-notary-token` with the user's session cookie, get back endorsement. **Session cookie is still the real auth boundary — no reversing escapes that.**

---

## 3. HTTP bootstrap flow — mapped

All on `muse.ai` with session cookies:

| Order | Method | Path | Purpose |
|---|---|---|---|
| 1 | `POST` | `/api/hatch/vm/wake` | wake / provision per-user VM (returns `vm_id`) |
| 2 | `POST` | `/api/hatch/lease-vm` | lease / renew VM slot |
| 3 | `POST` | `/api/hatch/token` | short-lived EdDSA JWT (`auth_token`), `kid=HATCH_EDGE_TO_VM_ADMISSION:1` |
| 4 | `POST` | `/api/hatch/noise-notary-token` | sign client X25519 pubkey → `notary_token` |

Fixed constants (from `chunks/24vdgjhlw22uj.js`):
```
HATCH_SHARED_LB_HOST = "hatch.metaaivm.com"
NOISE_WS_PATH        = "/v1/noise"
HATCH_APP_ID         = "hatch-web"
```

Then open:
```
wss://hatch.metaaivm.com/v1/noise?vm_id=<uuid>&auth_token=<jwt>&notary_token=<endorsement>&app_id=hatch-web&request_id=<uuid>
```

Other `/api/hatch/*` endpoints discovered (not on the critical path for a text-chat proxy): `saved-spaces`, `invite`, `promotion`, `app`, `cloudflare`, `private`, `cvm`, `vesta`, `voice/voyager`, `voice/speech`, `voice/tts`, `voice/tts/stream`.

---

## 4. Inner protocol — partial, this is the hard part

- `chunks/2zxujh06i9lm7.js` ships a full protobuf runtime bootstrapped from `google/protobuf/descriptor.proto` → the client is **descriptor-driven protobuf**, almost certainly a `@bufbuild/protobuf`-style runtime. Only `google/protobuf/descriptor.proto` itself was found via the `(0,X.boot)({name:...,messageType:[...]})` form — the Hatch app-level `.proto` files are not inlined this way. They are either (a) fetched as binary FileDescriptorSets at runtime from the gateway, (b) emitted into chunks via a different code-generation macro I did not grep for, or (c) hand-encoded as JS classes.
- `chunks/11qbbeqlkqufw.js` has the gateway orchestrator: emits a `noise_handshake` trace, uses `isGatewayRequestError`, references `GatewayRequest` / `GatewayResponse` / `GatewayFrame`.
- `ChatMessage` appears in 27 chunks, `UserMessage` / `AssistantMessage` in 5 each, `SendMessage` in 3 — these are likely either enum field names or client-side TS types, not necessarily protobuf messages of the same name on the wire.

**Takeaway:** Noise is a solved sub-problem. The real reverse-engineering work is the application protobuf schema inside the Noise transport channel. Expect weeks, not days.

---

## 5. Go/no-go recommendation for Phase 1

**Go.** Phase 1 (prove end-to-end: real cookies → Noise handshake → first encrypted echo) is 2–3 days of focused work, no theoretical blockers:

1. **Day 1** — Python script: read cookies from a logged-in Chrome profile, hit the 4 bootstrap endpoints in order, verify `auth_token` + `notary_token` returned.
2. **Day 2** — Add Noise XX handshake with `dissononce` or `noise-protocol`, open the WS, exchange first 3 frames, confirm encrypted channel established (match client's first ~64-byte frame to our constructed one).
3. **Day 3** — Capture one real chat turn's decrypted frames, start reverse-engineering the inner protobuf. Dump each decrypted frame as `.bin`, run `protoc --decode_raw` to get field-tag types, correlate across turns.

**Phase 2 (text-only `send_message` → text-only `assistant_reply`)** is 1–2 weeks after that.
**Phase 3 (OpenAI-compatible wrapper, deploy)** is another week.

**Everything after** (attachments, widgets, tool calls, approvals, memory, perpetual re-RE as Meta ships updates) is open-ended — classic reverse-engineered proxy maintenance tax.

**Honest fragility note:** `dpl_AU2F73G98WTk6ngM4hDqSqzwsTaf` in every chunk URL is a Vercel deployment ID. Each Meta deploy mints a new one; any chunk ID or minified identifier we hard-reference will drift. The Noise suite + endpoint paths are stable surfaces; message schemas are not.

---

## 6. Next tool to build (if Phase 1 approved)

`bootstrap.py` — reads `muse.ai` session cookies from the local Chrome profile, performs steps 1–4 above, prints the WS URL ready to paste into a websocket client. No Noise yet. ~80 lines. Gives us a known-good handshake replay baseline before writing any crypto.

Say "go phase 1" and I'll scaffold `C:\Users\DESK0034\Documents\muse-ai-api\phase1\` with that script + a session-cookie extractor + a frame recorder.

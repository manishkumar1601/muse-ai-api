# Phase 2 — Noise XX handshake + frame recorder (02-10-2026)

## Goal

Open the Noise WS from `session.json`, do the 3-message XX handshake, derive transport cipher states, record every subsequent decrypted frame to disk.

## What I tried

1. **Picked `dissononce`** for Noise — pure Python, supports `Noise_XX_25519_AESGCM_SHA256` directly. One of 3 viable Python Noise libs (others: `noise-protocol`, `@chainsafe/libp2p-noise` via a port). Chose dissononce because its CipherState exposes the raw AES-GCM wrapper I needed.
2. **Picked `websocket-client`** for the WS. Immediately got 401 on the WS upgrade — same TLS/H2 fingerprinting that bit Phase 1.
3. **Swapped to `curl_cffi.Session.ws_connect()`** with the same Chrome header overrides as Phase 1 → WS upgrade accepted.
4. **Built msg1 with empty payload** — server tore down the connection with CLOSE_NOTIFY after my msg1 arrived.
5. **Re-read the browser bundle (`chunks/1w9duffuzanuc.js`)** — found that msg1 is called with `k = writeMessage1(buf)` where `buf = Writer.create().uint32(10).bytes(nonce).finish()` — i.e. a 2-byte protobuf tag `0x0a 0x20` followed by **32 bytes of CSPRNG client nonce**. The 2-byte version I had first tried (`0x10 0x01`) is the SharedAgent-branch literal that hatch-web never hits in prod.
6. **Sent correct msg1 (66 bytes total)** → server returned msg2 (166 bytes). Decrypted msg2 payload (70B).
7. **Sent msg3 with empty payload** (standard VM path) → cipher states split successfully.
8. **Server tore down the connection anyway** after ~1s of idle. Noticed from the browser capture that the browser sends an **immediate first encrypted frame** right after msg3 (within ~10ms). Added a 16-byte empty encrypted "kick" frame → server stayed open.
9. **First decrypted server frame** = valid `NoiseTransportFrame { chunk_id:0, chunk_index:0, total_chunks:1, payload: ServiceFrame.reset }` with the string "empty frame kind" inside. Expected (our kick was empty) — but proves the AES-GCM transport is in sync.

## What worked

- Noise XX via dissononce, with:
  ```python
  hs = HandshakeState(SymmetricState(CipherState(AESGCMCipher()), SHA256Hash()), X25519DH())
  hs.initialize(XXHandshakePattern(), True, b"", s=X25519DH().generate_keypair())
  ```
- `curl_cffi.Session(impersonate="chrome").ws_connect(url)` — Chrome TLS on the WS upgrade.
- msg1 payload = `bytes([0x0a, 0x20]) + secrets.token_bytes(32)` (34B inner, 66B total frame).
- msg3 payload = empty bytes for standard VM (confidential-VM path requires an RV challenge response).
- Kick frame = `cs_send.encrypt_with_ad(b"", b"")` — 16 bytes (AES-GCM auth tag over empty plaintext).
- Nonce layout for AES-GCM in Noise AES-GCM mode is big-endian 8-byte counter at bytes 4-11; dissononce's `struct.pack('>Q', n)` already matches Hatch's `DataView.setUint32(..., false)`.

## Gotchas (worth remembering)

1. **Stdlib WS libs (`websocket-client`, `websockets`) 401 on the WS upgrade** against hatch.metaaivm.com. Needs `curl_cffi` Chrome TLS.
2. **msg1 payload matters.** Empty → server disconnects. Correct is protobuf field 1 (bytes, 32B CSPRNG) = tag `0x0a 0x20` + 32 random bytes.
3. **Server idle-closes initiator in <1s after msg3.** Browser sends first encrypted frame within 10ms of msg3. We send a 16-byte empty-payload encrypted kick as placeholder.
4. **Noise AES-GCM nonce is spec-compliant big-endian** (unlike ChaChaPoly which is little-endian in Noise). dissononce follows the spec, matches Hatch.
5. **dissononce split returns `(c1, c2)` from the LAST write_message.** For XX initiator, c1 = our send cipher, c2 = our recv cipher.
6. **Server static key from handshake ≠ notary.public_key.** They're part of an attestation chain, not the same key. For a recorder we log the mismatch but don't block.

## Deliverables

`phase2/`:
- `handshake.py` — Noise handshake + frame recorder, ~280 lines
- `extract_protos.py` — pulls base64 `fileDesc(...)` blobs out of the JS, writes `.binpb` + a combined `.descset`
- `protos/` — 5 extracted FileDescriptorProto files (`noise_transport`, `noise_envelope`, `attestation_bundle`, `plexi_types`, `revocation_list`) + `_all.descset`
- `frames/<ts>/` — per-run ciphertext + plaintext dumps (gitignored)
- `README.md`, `requirements.txt`

## Next

Phase 3: use `noise_envelope.proto` to craft real `ApplicationRequest`s, enumerate DAEMON HTTP routes.

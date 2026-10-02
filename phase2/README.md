# Phase 2 — Noise XX handshake + encrypted-frame recorder

Takes `../phase1/session.json`, runs the full `Noise_XX_25519_AESGCM_SHA256` handshake against `wss://hatch.metaaivm.com/v1/noise?...`, derives transport cipher states, and dumps every subsequent frame (ciphertext **and** plaintext) to `frames/<timestamp>/`.

**Status: encrypted channel confirmed working.** First decrypted server frame parses as a valid `NoiseTransportFrame` protobuf. Reversing the application-layer `ServiceFrame`/`ServiceRequest` schema is Phase 3.

## Install

```
pip install -r requirements.txt
```

Uses `curl_cffi` (Chrome TLS impersonation — stdlib WS libs get 401'd on the WS upgrade) and `dissononce` (pure-Python Noise impl, supports our exact suite).

## Run

```bash
python handshake.py                    # defaults: ../phase1/session.json -> frames/<ts>/
python handshake.py --self-check       # offline sanity
python handshake.py --listen-seconds 30
python extract_protos.py               # pull every fileDesc() protobuf blob out of the saved chunks
```

Each handshake run creates `frames/YYYYMMDD_HHMMSS/` containing:

```
01_sent_msg1.bin          — our raw 66B msg1 (32B e-pub + 34B nonce payload)
01_sent_msg1_payload.bin  — just the 34B payload (0x0a 0x20 + 32 CSPRNG bytes)
02_recv_msg2.bin          — server's raw 166B msg2
02_recv_msg2_payload.bin  — decrypted 70B payload (contains server static + attestation sub-msg)
03_sent_msg3.bin          — our raw 64B msg3 (encrypted static + empty payload MAC)
04_sent_kick.bin          — 16B empty encrypted frame to keep server from idle-closing
rx_NNNN_ct_<N>B.bin       — N-th received transport frame (ciphertext)
rx_NNNN_pt_<N>B.bin       — same frame decrypted (plaintext NoiseTransportFrame protobuf)
manifest.json             — run metadata + stats
```

## What Phase 2 proved

1. **`Noise_XX_25519_AESGCM_SHA256`** is literal textbook Noise XX with no twists. `dissononce` interoperates with Hatch's custom JS impl byte-for-byte once you match the nonce layout (big-endian 8-byte counter — dissononce is correct, same as Noise spec for AES-GCM).
2. **Msg1 payload format** (standard-VM path): `0x0a 0x20 <32 CSPRNG bytes>` — a protobuf-encoded 32-byte client freshness nonce (field 1, length-delimited). The 2-byte version in `chunks/1w9duffuzanuc.js` is the SharedAgent branch, never hit in prod.
3. **Msg2 structure** (decrypted 70B): `0x12 0x44 <68B sub-msg>` where the sub-msg contains the VM's actual Noise static key (field 1, 32B) plus 36 bytes of attestation. The `notary_token.public_key` from Phase 1 is a parent/CA key — **does not** equal the VM's static; it chains to it via that 36B attestation inside msg2. Verifying the chain is a Phase 3 task.
4. **Msg3 payload is empty** for standard VMs. The RV-challenge path only kicks in for confidential VMs.
5. **Post-handshake liveness**: server tears down an idle initiator within ~1 s. The browser sends its first encrypted ServiceRequest ~10 ms after msg3. We send an empty encrypted frame as a kick; server replies with an `empty frame kind` reset — enough to prove transport decrypt works.
6. **Protobuf app schemas are NOT in `fileDesc()` form.** `extract_protos.py` across all 210 chunks finds only 5 descriptors — `noise_transport.proto`, `noise_envelope.proto`, `attestation_bundle.proto`, `plexi_types.proto`, `revocation_list.proto`. The `ChatMessage` / `GatewayRequest` / `ServiceFrame` application messages are compiled into JS classes directly (likely `@bufbuild/protobuf-es` generated code with inline field descriptors). Phase 3 will either (a) extract them from the compiled JS via AST, or (b) reverse by observing many decrypted frames and running `protoc --decode_raw`.

## Files

```
handshake.py          — the main script (170 lines)
extract_protos.py     — base64 fileDesc() extractor
requirements.txt      — curl_cffi, dissononce
.gitignore            — frames/ (recorded cipher material)
protos/               — extracted *.binpb FileDescriptorProto blobs + _all.descset
frames/               — timestamped handshake artifacts (gitignored)
```

## Known limits / next

- `server_pub_matches_notary == False` is **not an error** — see point 3 above. The notary ties the VM via a signed chain; verification needs parsing `attestation_bundle.proto`.
- Only 1 frame per run is captured because our kick frame is invalid at the app layer and server responds with a single reset. Phase 3 crafts a real `ServiceRequest` → expect bursts of 100+ frames per turn.
- Nothing re-handshakes on token expiry. If `session.json` is stale, re-run `../phase1/bootstrap.py`.
- No tests beyond `--self-check`. The whole thing is a research recorder, not production code.

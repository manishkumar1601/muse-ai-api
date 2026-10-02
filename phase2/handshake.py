"""Phase 2 — speak Noise_XX_25519_AESGCM_SHA256 to Hatch and dump every decrypted frame.

Reads session.json (output of ../phase1/bootstrap.py), opens the WebSocket, does the
3-message XX handshake, then records every subsequent transport frame to ./frames/
as both ciphertext and plaintext.

Usage:
    python handshake.py                            # defaults
    python handshake.py --session ../phase1/session.json --out ./frames
    python handshake.py --listen-seconds 15        # record for 15s after handshake (default 10)
    python handshake.py --self-check               # offline sanity: can we build the Noise state?
"""

import argparse
import base64
import json
import os
import secrets
import struct
import sys
import time
from pathlib import Path

from dissononce.processing.handshakepatterns.interactive.XX import XXHandshakePattern
from dissononce.processing.impl.handshakestate import HandshakeState
from dissononce.processing.impl.symmetricstate import SymmetricState
from dissononce.processing.impl.cipherstate import CipherState
from dissononce.dh.x25519.x25519 import X25519DH
from dissononce.cipher.aesgcm import AESGCMCipher
from dissononce.hash.sha256 import SHA256Hash

# ponytail: stdlib-TLS WS libs (websocket-client, websockets) get 401'd by Hatch edge
# on the WS upgrade — same JA3/H2 fingerprinting that bit the HTTP endpoints in Phase 1.
# curl_cffi's WebSocket inherits Chrome TLS from the Session's `impersonate`.
from curl_cffi import requests as cc_requests  # type: ignore
from curl_cffi.const import CurlWsFlag  # type: ignore


# Observed msg1 payload for a STANDARD VM (chunks/1w9duffuzanuc.js, encodeNoiseClientNonceMessage1):
#   protobufjs: Writer.create().uint32(10).bytes(32-random-bytes).finish()
#   -> tag 0x0a (field 1, length-delimited) + length 0x20 (32) + 32 bytes of CSPRNG nonce
# This is the "freshness challenge" the server echoes back in msg2's attestation payload.
# The 2-byte {field 2 varint = 1} version is the SharedAgent code path, not used by hatch-web.
def build_msg1_payload() -> bytes:
    nonce = secrets.token_bytes(32)
    return bytes([0x0A, 0x20]) + nonce


def build_handshake() -> tuple[HandshakeState, bytes]:
    """Fresh initiator state. Returns (hs, client_static_pub) for later logging."""
    dh = X25519DH()
    cs = CipherState(AESGCMCipher())
    ss = SymmetricState(cs, SHA256Hash())
    hs = HandshakeState(ss, dh)
    s = dh.generate_keypair()
    # XX initiator: s=our static, e generated internally during write_message
    hs.initialize(XXHandshakePattern(), True, b"", s=s)
    return hs, s.public.data


def decode_notary_attestation(notary_token: str) -> dict:
    """notary_token = endorsement.v1.<b64 payload>.<b64 sig>.<b64 uri>.<b64 sig2>
    Returns parsed payload (restrictions, identity, public_key).
    """
    parts = notary_token.split(".")
    if len(parts) < 3 or parts[0] != "endorsement" or parts[1] != "v1":
        return {}
    pad = lambda s: s + "=" * (-len(s) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(pad(parts[2])))
    except Exception:
        return {}
    return payload


def hexpreview(b: bytes, n: int = 32) -> str:
    return b[:n].hex() + ("..." if len(b) > n else "")


def run(args) -> int:
    session_path = Path(args.session)
    if not session_path.exists():
        print(f"session.json not found at {session_path} — run ../phase1/bootstrap.py first", file=sys.stderr)
        return 2
    sess = json.loads(session_path.read_text(encoding="utf-8"))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    run_tag = time.strftime("%Y%m%d_%H%M%S")
    run_dir = out_dir / run_tag
    run_dir.mkdir(parents=True, exist_ok=True)

    ws_url = sess["ws_url"]
    notary = decode_notary_attestation(sess["notary_token"])
    server_pub_claimed = notary.get("public_key", {}).get("key")
    identity = notary.get("identity")
    restrictions = notary.get("restrictions")

    print(f"opening {ws_url[:120]}...", file=sys.stderr)
    print(f"notary identity: {identity}", file=sys.stderr)
    print(f"notary restrictions: {restrictions}", file=sys.stderr)
    print(f"notary server pub (b64): {server_pub_claimed}", file=sys.stderr)

    # Build Noise state
    hs, client_static_pub = build_handshake()
    print(f"client static pub (hex): {client_static_pub.hex()}", file=sys.stderr)

    # Open WebSocket via curl_cffi (Chrome TLS impersonation).
    cc_session = cc_requests.Session(impersonate="chrome")
    cc_session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Origin": "https://muse.ai",
    })
    ws = cc_session.ws_connect(ws_url)

    try:
        # --- msg 1: client -> server (e + payload) ---
        msg1_payload = build_msg1_payload()
        msg1_buf = bytearray()
        hs.write_message(msg1_payload, msg1_buf)
        (run_dir / "01_sent_msg1.bin").write_bytes(bytes(msg1_buf))
        (run_dir / "01_sent_msg1_payload.bin").write_bytes(msg1_payload)
        print(f"[msg1] sending {len(msg1_buf)}B (payload={len(msg1_payload)}B client-nonce): {hexpreview(bytes(msg1_buf))}", file=sys.stderr)
        ws.send(bytes(msg1_buf), flags=CurlWsFlag.BINARY)

        # --- msg 2: server -> client (e, ee, s, es + payload) ---
        msg2, flag2 = ws.recv()
        if flag2 & CurlWsFlag.TEXT:
            print(f"[msg2] got TEXT frame (unexpected): {msg2[:300]!r}", file=sys.stderr)
            return 1
        (run_dir / "02_recv_msg2.bin").write_bytes(msg2)
        print(f"[msg2] got {len(msg2)}B: {hexpreview(msg2)}", file=sys.stderr)

        msg2_payload = bytearray()
        hs.read_message(msg2, msg2_payload)
        (run_dir / "02_recv_msg2_payload.bin").write_bytes(bytes(msg2_payload))
        print(f"[msg2 payload] {len(msg2_payload)}B: {hexpreview(bytes(msg2_payload))}", file=sys.stderr)

        # Extract server static key — in dissononce it's hs.rs (remote static) after reading msg2
        server_static = hs.rs.data if hs.rs else b""
        print(f"server static pub (hex): {server_static.hex()}", file=sys.stderr)

        # Compare against notary attestation
        if server_pub_claimed:
            try:
                claimed_raw = base64.b64decode(server_pub_claimed + "=" * (-len(server_pub_claimed) % 4))
                match = claimed_raw == server_static
                print(f"server pub matches notary: {match}  (notary claimed {len(claimed_raw)}B, got {len(server_static)}B)", file=sys.stderr)
                if not match:
                    print(f"  claimed: {claimed_raw.hex()}", file=sys.stderr)
                    print(f"  actual:  {server_static.hex()}", file=sys.stderr)
            except Exception as e:
                print(f"could not decode notary pubkey for comparison: {e}", file=sys.stderr)

        # --- msg 3: client -> server (s, se + payload) ---
        # Observed in bundle: `writeMessage3(O)` where O = result of `b(M, e, T, K, E)` -
        # for "standard" VMs (M == null) this is empty.
        msg3_buf = bytearray()
        pair = hs.write_message(b"", msg3_buf)
        (run_dir / "03_sent_msg3.bin").write_bytes(bytes(msg3_buf))
        print(f"[msg3] sending {len(msg3_buf)}B: {hexpreview(bytes(msg3_buf))}", file=sys.stderr)
        ws.send(bytes(msg3_buf), flags=CurlWsFlag.BINARY)

        # Noise spec: last writeMessage returns (c1, c2). For an initiator in an interactive
        # pattern, c1 = initiator's send cipher, c2 = initiator's recv cipher.
        if pair is None:
            raise RuntimeError("Noise split did not produce cipher states")
        cs_send, cs_recv = pair

        # --- kick: server disconnects an idle initiator post-handshake. Browser's trace
        # shows a 210-byte encrypted frame goes out ~10ms after msg3. Send a minimal
        # placeholder — an empty-ad AES-GCM frame carrying an empty NoiseTransportFrame
        # (zero bytes) — so the server stays open while we observe its initial burst.
        kick = cs_send.encrypt_with_ad(b"", b"")
        (run_dir / "04_sent_kick.bin").write_bytes(kick)
        print(f"[kick] sending {len(kick)}B empty transport frame to keep server alive", file=sys.stderr)
        ws.send(kick, flags=CurlWsFlag.BINARY)

        # --- record incoming transport frames ---
        print(f"\n[transport] handshake complete. listening for {args.listen_seconds}s...", file=sys.stderr)
        start = time.time()
        idx = 0
        total_ct = 0
        total_pt = 0
        while time.time() - start < args.listen_seconds:
            try:
                frame, flag = ws.recv()
            except Exception as e:
                # curl_cffi raises on timeout/closed; break out
                if "timeout" in str(e).lower() or "again" in str(e).lower():
                    continue
                print(f"[transport] recv error: {e}", file=sys.stderr)
                break
            if frame is None or len(frame) == 0:
                continue
            if flag & CurlWsFlag.CLOSE:
                print(f"[transport #{idx}] CLOSE frame received", file=sys.stderr)
                break
            if flag & CurlWsFlag.TEXT:
                print(f"[transport #{idx}] TEXT: {frame[:200]!r}", file=sys.stderr)
                continue
            idx += 1
            total_ct += len(frame)
            (run_dir / f"rx_{idx:04d}_ct_{len(frame)}B.bin").write_bytes(frame)
            try:
                plain = cs_recv.decrypt_with_ad(b"", frame)
                total_pt += len(plain)
                (run_dir / f"rx_{idx:04d}_pt_{len(plain)}B.bin").write_bytes(plain)
                if idx <= 5 or idx % 20 == 0:
                    print(f"[transport #{idx}] ct={len(frame)}B pt={len(plain)}B head={hexpreview(plain, 24)}", file=sys.stderr)
            except Exception as e:
                print(f"[transport #{idx}] DECRYPT FAILED ({e}) — ct={len(frame)}B head={hexpreview(frame)}", file=sys.stderr)
                break

        print(f"\n[done] recorded {idx} frames | ct={total_ct}B pt={total_pt}B", file=sys.stderr)
        print(f"       artifacts in {run_dir}", file=sys.stderr)

        # Summary manifest for Phase 3
        manifest = {
            "run_tag": run_tag,
            "ws_url_vm_id": sess["vm_id"],
            "noise_suite": sess["noise_suite"],
            "client_static_pub_hex": client_static_pub.hex(),
            "server_static_pub_hex": server_static.hex(),
            "server_pub_matches_notary": (
                base64.b64decode(server_pub_claimed + "=" * (-len(server_pub_claimed) % 4)) == server_static
                if server_pub_claimed else None
            ),
            "msg1_payload_hex": msg1_payload.hex(),
            "msg2_payload_len": len(msg2_payload),
            "msg2_payload_hex": bytes(msg2_payload).hex(),
            "transport_frames": idx,
            "total_ciphertext_bytes": total_ct,
            "total_plaintext_bytes": total_pt,
            "listen_seconds": args.listen_seconds,
        }
        (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return 0

    finally:
        try:
            ws.close()
        except Exception:
            pass


def _self_check():
    """No-network sanity: Noise state builds, msg1 produces 32B+payload, nonce encoding is right."""
    p = build_msg1_payload()
    assert len(p) == 34 and p[0] == 0x0A and p[1] == 0x20, f"nonce encoding wrong: {p[:4].hex()}"
    hs, pub = build_handshake()
    buf = bytearray()
    hs.write_message(p, buf)
    assert len(buf) == 32 + 34, f"msg1 len {len(buf)} != 66"
    assert buf[:32] != b"\x00" * 32, "epk is all zeros"
    assert len(pub) == 32, f"client static pub len {len(pub)}"

    # notary payload decoder
    sample = (
        "endorsement.v1."
        + base64.urlsafe_b64encode(b'{"restrictions":["timeout:1"],"identity":"42","public_key":{"key":"AAAA","algorithm":"ed25519-public"}}').rstrip(b"=").decode()
        + ".sig.uri.sig2"
    )
    attn = decode_notary_attestation(sample)
    assert attn["identity"] == "42"
    assert attn["public_key"]["algorithm"] == "ed25519-public"
    print("self-check: OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="../phase1/session.json")
    ap.add_argument("--out", default="./frames")
    ap.add_argument("--listen-seconds", type=int, default=10)
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()

    if args.self_check:
        _self_check()
        return
    sys.exit(run(args))


if __name__ == "__main__":
    main()

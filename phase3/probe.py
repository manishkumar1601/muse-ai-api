"""Phase 3 — once Noise transport is up, send a real ServiceRequest and record what the VM says.

Learned from the descriptors (../phase3/decode_descriptors.py output):
- Transport is HTTP-over-Noise. Each ServiceFrame carries an ApplicationRequest
  (verb/path/headers/body/end_body) targeted at one of {DAEMON, SENTINEL, VAULT, AUTHD}.
- Framing per frame:
    NoiseTransportFrame { chunk_id, chunk_index, total_chunks, payload }
      payload = ServiceRequest { service, payload: ServiceFrame bytes }   (client->server)
      payload = ServiceResponse { payload: ServiceFrame bytes }           (server->client)

Usage:
    python probe.py                             # default: GET / against SERVICE_DAEMON
    python probe.py --service DAEMON --verb GET --path /
    python probe.py --listen-seconds 10
"""

import argparse
import base64
import json
import os
import secrets
import sys
import time
from pathlib import Path

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

from dissononce.processing.handshakepatterns.interactive.XX import XXHandshakePattern
from dissononce.processing.impl.handshakestate import HandshakeState
from dissononce.processing.impl.symmetricstate import SymmetricState
from dissononce.processing.impl.cipherstate import CipherState
from dissononce.dh.x25519.x25519 import X25519DH
from dissononce.cipher.aesgcm import AESGCMCipher
from dissononce.hash.sha256 import SHA256Hash

from curl_cffi import requests as cc_requests
from curl_cffi.const import CurlWsFlag


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36")


# ---- protobuf descriptor loading ---------------------------------------------

def load_pool() -> tuple[descriptor_pool.DescriptorPool, dict]:
    """Load the 5 Hatch descriptors into a dynamic pool, return factory classes."""
    pool = descriptor_pool.DescriptorPool()
    desc_dir = Path("../phase2/protos")
    # Order matters when there are cross-file deps. These 5 are self-contained.
    for p in sorted(desc_dir.glob("*.binpb")):
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.ParseFromString(p.read_bytes())
        try:
            pool.Add(fdp)
        except TypeError:
            # already present (if run twice)
            pass
    classes = {}
    for full_name in (
        "ingress_rev_proxy.NoiseTransportFrame",
        "hatch.noise.ServiceRequest",
        "hatch.noise.ServiceResponse",
        "hatch.noise.ServiceFrame",
        "hatch.noise.ApplicationRequest",
        "hatch.noise.ApplicationResponse",
        "hatch.noise.BodyChunk",
        "hatch.noise.Reset",
        "hatch.noise.Header",
    ):
        d = pool.FindMessageTypeByName(full_name)
        classes[full_name.split(".")[-1]] = message_factory.GetMessageClass(d)
    # ServiceType enum values
    st = pool.FindEnumTypeByName("hatch.noise.ServiceType")
    classes["_service_type_values"] = {v.name: v.number for v in st.values}
    return pool, classes


# ---- Noise handshake (same as phase2/handshake.py, minimal) ------------------

def build_handshake():
    dh = X25519DH()
    cs = CipherState(AESGCMCipher())
    ss = SymmetricState(cs, SHA256Hash())
    hs = HandshakeState(ss, dh)
    s = dh.generate_keypair()
    hs.initialize(XXHandshakePattern(), True, b"", s=s)
    return hs


def build_msg1_payload() -> bytes:
    return bytes([0x0A, 0x20]) + secrets.token_bytes(32)


def decode_notary(notary_token: str) -> dict:
    parts = notary_token.split(".")
    if len(parts) < 3 or parts[0] != "endorsement":
        return {}
    pad = lambda s: s + "=" * (-len(s) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(pad(parts[2])))
    except Exception:
        return {}


# ---- Frame recording ---------------------------------------------------------

def recv_one(ws, timeout_s: float = 1.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            frame, flag = ws.recv()
        except Exception as e:
            if "timeout" in str(e).lower() or "again" in str(e).lower():
                continue
            raise
        if frame is None or len(frame) == 0:
            continue
        return frame, flag
    return None, 0


def pretty_sf(sf) -> str:
    """One-line summary of a ServiceFrame for logs."""
    kind = sf.WhichOneof("kind") or "<none>"
    if kind == "response":
        r = sf.response
        hdrs = ",".join(f"{h.key}={h.value}" for h in r.headers)
        return f"stream={sf.stream_id} RESPONSE status={r.status} end={r.end_body} body={len(r.body)}B [{hdrs}]"
    if kind == "request":
        r = sf.request
        hdrs = ",".join(f"{h.key}={h.value}" for h in r.headers)
        return f"stream={sf.stream_id} REQUEST {r.verb} {r.path} end={r.end_body} body={len(r.body)}B [{hdrs}]"
    if kind == "body_chunk":
        return f"stream={sf.stream_id} BODY_CHUNK data={len(sf.body_chunk.data)}B end={sf.body_chunk.end_body}"
    if kind == "reset":
        r = sf.reset
        return f"stream={sf.stream_id} RESET code={r.code} reason={r.reason!r}"
    return f"stream={sf.stream_id} kind={kind}"


def run(args) -> int:
    sess_path = Path(args.session)
    if not sess_path.exists():
        print(f"session.json missing: {sess_path} — rerun phase1 bootstrap", file=sys.stderr)
        return 2
    sess = json.loads(sess_path.read_text("utf-8"))

    out_dir = Path(args.out) / time.strftime("%Y%m%d_%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    pool, M = load_pool()
    service_val = M["_service_type_values"].get(f"SERVICE_{args.service.upper()}")
    if service_val is None:
        print(f"unknown service {args.service}. Try: {list(M['_service_type_values'])}", file=sys.stderr)
        return 2

    # ---- open WS + handshake ---------
    cc_sess = cc_requests.Session(impersonate="chrome")
    cc_sess.headers.update({
        "User-Agent": UA,
        "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Origin": "https://muse.ai",
    })

    print(f"opening {sess['ws_url'][:120]}...", file=sys.stderr)
    ws = cc_sess.ws_connect(sess["ws_url"])

    hs = build_handshake()
    msg1_payload = build_msg1_payload()
    buf1 = bytearray()
    hs.write_message(msg1_payload, buf1)
    ws.send(bytes(buf1), flags=CurlWsFlag.BINARY)

    msg2, _ = ws.recv()
    msg2_pt = bytearray()
    hs.read_message(msg2, msg2_pt)

    buf3 = bytearray()
    pair = hs.write_message(b"", buf3)
    ws.send(bytes(buf3), flags=CurlWsFlag.BINARY)
    cs_send, cs_recv = pair
    print(f"[noise] handshake OK  server_static={hs.rs.data.hex()[:32]}... cs_send={cs_send} cs_recv={cs_recv}", file=sys.stderr)

    # ---- build request ---------
    stream_id = 1
    chunk_id = 1

    AppReq = M["ApplicationRequest"]
    SvcFrame = M["ServiceFrame"]
    SvcReq = M["ServiceRequest"]
    TxFrame = M["NoiseTransportFrame"]

    app_req = AppReq(verb=args.verb, path=args.path, end_body=True)
    svc_frame = SvcFrame(stream_id=stream_id, request=app_req)
    svc_req = SvcReq(service=service_val, payload=svc_frame.SerializeToString())
    tx_frame = TxFrame(
        chunk_id=chunk_id,
        chunk_index=0,
        total_chunks=1,
        payload=svc_req.SerializeToString(),
    )
    plaintext = tx_frame.SerializeToString()
    (out_dir / "tx_001_pt.bin").write_bytes(plaintext)

    ciphertext = cs_send.encrypt_with_ad(b"", plaintext)
    (out_dir / "tx_001_ct.bin").write_bytes(ciphertext)
    print(f"[send] service={args.service} {args.verb} {args.path}  pt={len(plaintext)}B ct={len(ciphertext)}B", file=sys.stderr)
    ws.send(ciphertext, flags=CurlWsFlag.BINARY)

    # ---- record responses ---------
    print(f"\n[recv] listening {args.listen_seconds}s...", file=sys.stderr)
    deadline = time.time() + args.listen_seconds
    rx_idx = 0
    assembled = {}  # chunk_id -> {idx: bytes, total: int}
    try:
        while time.time() < deadline:
            try:
                frame, flag = ws.recv()
            except Exception as e:
                if "timeout" in str(e).lower() or "again" in str(e).lower():
                    continue
                print(f"[recv] error: {e}", file=sys.stderr)
                break
            if frame is None or len(frame) == 0:
                continue
            if flag & CurlWsFlag.CLOSE:
                print("[recv] CLOSE frame", file=sys.stderr)
                break
            rx_idx += 1
            (out_dir / f"rx_{rx_idx:04d}_ct_{len(frame)}B.bin").write_bytes(frame)
            try:
                pt = cs_recv.decrypt_with_ad(b"", frame)
            except Exception as e:
                print(f"[rx #{rx_idx}] DECRYPT FAIL: {e}", file=sys.stderr)
                break
            (out_dir / f"rx_{rx_idx:04d}_pt_{len(pt)}B.bin").write_bytes(pt)
            # parse as NoiseTransportFrame
            try:
                tx = TxFrame()
                tx.ParseFromString(pt)
            except Exception as e:
                print(f"[rx #{rx_idx}] not NoiseTransportFrame: {e}", file=sys.stderr)
                continue
            cid = tx.chunk_id
            idx = tx.chunk_index
            tot = tx.total_chunks
            buf = assembled.setdefault(cid, {"chunks": {}, "total": tot})
            buf["chunks"][idx] = tx.payload
            if len(buf["chunks"]) < buf["total"]:
                print(f"[rx #{rx_idx}] chunk cid={cid} {idx+1}/{tot} ({len(tx.payload)}B)", file=sys.stderr)
                continue
            # all chunks for this stream in — reassemble
            payload = b"".join(buf["chunks"][i] for i in range(buf["total"]))
            assembled.pop(cid)
            # Parse as ServiceResponse { payload: ServiceFrame bytes }
            try:
                sr = M["ServiceResponse"]()
                sr.ParseFromString(payload)
                sf = SvcFrame()
                sf.ParseFromString(sr.payload)
                print(f"[rx #{rx_idx}] cid={cid} assembled={len(payload)}B  SvcFrame: {pretty_sf(sf)}", file=sys.stderr)
                if sf.WhichOneof("kind") == "response" and sf.response.body:
                    body = sf.response.body
                    body_preview = body[:120] if len(body) < 200 else body[:200] + b"..."
                    print(f"           body preview: {body_preview!r}", file=sys.stderr)
                    (out_dir / f"rx_{rx_idx:04d}_body.bin").write_bytes(body)
            except Exception as e:
                # Maybe server didn't wrap in ServiceResponse — try bare ServiceFrame
                try:
                    sf = SvcFrame()
                    sf.ParseFromString(payload)
                    print(f"[rx #{rx_idx}] cid={cid} BARE SvcFrame: {pretty_sf(sf)}", file=sys.stderr)
                except Exception as e2:
                    print(f"[rx #{rx_idx}] cid={cid} unparseable ({e} // {e2}): {payload[:60].hex()}", file=sys.stderr)
    finally:
        try: ws.close()
        except Exception: pass

    print(f"\n[done] frames in {out_dir}", file=sys.stderr)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="../phase1/session.json")
    ap.add_argument("--out", default="./frames")
    ap.add_argument("--service", default="DAEMON", help="DAEMON|SENTINEL|VAULT|AUTHD")
    ap.add_argument("--verb", default="GET")
    ap.add_argument("--path", default="/")
    ap.add_argument("--listen-seconds", type=int, default=8)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()

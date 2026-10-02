"""Open ONE Noise channel, send a batch of probes, correctly assemble streaming bodies,
and record every response. Discovers the Hatch VM-side HTTP route surface.

Usage:
    python sweep.py                       # defaults
    python sweep.py --listen-seconds 15
    python sweep.py --probes custom.json  # custom probe list
"""

import argparse
import collections
import json
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


# (service_name, verb, path, body_json_or_none)
DEFAULT_PROBES = [
    # Confirmed reachable from previous sweep
    ("SENTINEL", "GET", "/healthz", None),
    ("AUTHD",    "GET", "/healthz", None),

    # DAEMON — the main hatch agent host
    *[("DAEMON", "GET", p, None) for p in (
        "/", "/healthz", "/health", "/version",
        "/graphql", "/v1/graphql", "/query", "/rpc",
        "/chat", "/v1/chat", "/chat/stream", "/chat/messages",
        "/conversation", "/conversations", "/thread", "/threads",
        "/agent", "/agent/message", "/message",
        "/api", "/api/v1", "/library", "/feed", "/ideas", "/goals",
        "/settings", "/profile", "/user", "/me",
        "/connectors", "/approvals",
        "/debug", "/_debug", "/routes", "/_routes", "/metrics",
    )],

    # DAEMON POST probes — chat sends are POSTs
    ("DAEMON", "POST", "/graphql", {"query": "{__typename}"}),
    ("DAEMON", "POST", "/chat", {"message": "test"}),
    ("DAEMON", "POST", "/chat/send", {"text": "test"}),
    ("DAEMON", "POST", "/v1/chat/send", {"text": "test"}),
    ("DAEMON", "POST", "/message", {"text": "test"}),

    # Other services with their own healthz pattern
    ("SENTINEL", "GET", "/version", None),
    ("AUTHD",    "GET", "/version", None),
    ("AUTHD",    "GET", "/me", None),
    ("VAULT",    "GET", "/healthz", None),
    ("VAULT",    "GET", "/version", None),
]


def load_pool():
    pool = descriptor_pool.DescriptorPool()
    for p in sorted(Path("../phase2/protos").glob("*.binpb")):
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.ParseFromString(p.read_bytes())
        try: pool.Add(fdp)
        except TypeError: pass
    M = {n.split(".")[-1]: message_factory.GetMessageClass(pool.FindMessageTypeByName(n))
         for n in ("ingress_rev_proxy.NoiseTransportFrame",
                   "hatch.noise.ServiceRequest", "hatch.noise.ServiceResponse",
                   "hatch.noise.ServiceFrame", "hatch.noise.ApplicationRequest",
                   "hatch.noise.ApplicationResponse", "hatch.noise.BodyChunk",
                   "hatch.noise.Reset", "hatch.noise.Header")}
    M["_svc"] = {v.name: v.number for v in pool.FindEnumTypeByName("hatch.noise.ServiceType").values}
    return M


def noise_handshake(ws):
    hs = HandshakeState(SymmetricState(CipherState(AESGCMCipher()), SHA256Hash()), X25519DH())
    hs.initialize(XXHandshakePattern(), True, b"", s=X25519DH().generate_keypair())
    b1 = bytearray()
    hs.write_message(bytes([0x0A, 0x20]) + secrets.token_bytes(32), b1)
    ws.send(bytes(b1), flags=CurlWsFlag.BINARY)
    msg2, _ = ws.recv()
    hs.read_message(msg2, bytearray())
    b3 = bytearray()
    pair = hs.write_message(b"", b3)
    ws.send(bytes(b3), flags=CurlWsFlag.BINARY)
    return pair, hs.rs.data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="../phase1/session.json")
    ap.add_argument("--out", default="./sweep_out")
    ap.add_argument("--probes", help="path to a JSON list of [svc, verb, path, body?] tuples")
    ap.add_argument("--listen-seconds", type=int, default=15)
    args = ap.parse_args()

    sess = json.loads(Path(args.session).read_text("utf-8"))
    M = load_pool()
    out_dir = Path(args.out) / time.strftime("%Y%m%d_%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    probes = DEFAULT_PROBES
    if args.probes:
        probes = [tuple(x) for x in json.loads(Path(args.probes).read_text("utf-8"))]

    cc = cc_requests.Session(impersonate="chrome")
    cc.headers.update({
        "User-Agent": UA,
        "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Origin": "https://muse.ai",
    })
    ws = cc.ws_connect(sess["ws_url"], timeout=15)
    # Short per-recv timeout so blocking recv doesn't hang after the server drains
    try: ws.curl.setopt(ws.curl.TIMEOUT_MS, 2000)
    except Exception: pass
    (cs_send, cs_recv), server_static = noise_handshake(ws)
    print(f"[noise] OK server_static={server_static.hex()[:16]}...", file=sys.stderr, flush=True)

    # Fire all probes on distinct stream_ids
    streams = {}  # sid -> (svc, verb, path)
    sid = 1
    cid = 1
    for probe in probes:
        svc, verb, path, body = (probe + (None,))[:4] if len(probe) < 4 else probe
        body_bytes = json.dumps(body).encode() if body else b""
        headers = [M["Header"](key="content-type", value="application/json")] if body else []
        req = M["ApplicationRequest"](verb=verb, path=path, headers=headers, body=body_bytes, end_body=True)
        sf = M["ServiceFrame"](stream_id=sid, request=req)
        sr = M["ServiceRequest"](service=M["_svc"][f"SERVICE_{svc}"], payload=sf.SerializeToString())
        tx = M["NoiseTransportFrame"](chunk_id=cid, chunk_index=0, total_chunks=1,
                                      payload=sr.SerializeToString())
        ws.send(cs_send.encrypt_with_ad(b"", tx.SerializeToString()), flags=CurlWsFlag.BINARY)
        streams[sid] = (svc, verb, path)
        sid += 1
        cid += 1

    print(f"[send] {len(streams)} probes fired", file=sys.stderr, flush=True)

    # Count responses to break early when everything's answered + grace period
    all_sids = set(streams.keys())
    seen_ends = set()

    # Receive — reassemble NoiseTransportFrame chunks, then correlate ServiceFrames by stream_id
    tx_assemblies = {}  # chunk_id -> {chunks, total}
    stream_state = collections.defaultdict(lambda: {"status": None, "headers": [], "body": bytearray(), "ended": False, "reset": None})
    deadline = time.time() + args.listen_seconds

    while time.time() < deadline:
        try: frame, flag = ws.recv()
        except Exception as e:
            if "timeout" in str(e).lower() or "again" in str(e).lower(): continue
            print(f"[recv] error: {e}", file=sys.stderr, flush=True); break
        if not frame: continue
        if flag & CurlWsFlag.CLOSE: break
        try: pt = cs_recv.decrypt_with_ad(b"", frame)
        except Exception as e: print(f"[recv] decrypt fail: {e}", file=sys.stderr, flush=True); break
        try:
            txf = M["NoiseTransportFrame"](); txf.ParseFromString(pt)
        except Exception: continue
        cid2 = txf.chunk_id
        buf = tx_assemblies.setdefault(cid2, {"chunks": {}, "total": txf.total_chunks})
        buf["chunks"][txf.chunk_index] = txf.payload
        if len(buf["chunks"]) < buf["total"]:
            continue
        payload = b"".join(buf["chunks"][i] for i in range(buf["total"]))
        tx_assemblies.pop(cid2)
        try:
            sr = M["ServiceResponse"](); sr.ParseFromString(payload)
            sf = M["ServiceFrame"](); sf.ParseFromString(sr.payload)
        except Exception:
            print(f"[recv] cid={cid2} ServiceFrame parse failed; raw head: {payload[:40].hex()}", file=sys.stderr, flush=True)
            continue
        kind = sf.WhichOneof("kind")
        st = stream_state[sf.stream_id]
        if kind == "response":
            st["status"] = sf.response.status
            st["headers"] = [(h.key, h.value) for h in sf.response.headers]
            st["body"].extend(sf.response.body)
            st["ended"] = sf.response.end_body
        elif kind == "body_chunk":
            st["body"].extend(sf.body_chunk.data)
            st["ended"] = sf.body_chunk.end_body
        elif kind == "reset":
            st["reset"] = (sf.reset.code, sf.reset.reason)
            st["ended"] = True
        if st.get("ended"):
            seen_ends.add(sf.stream_id)
        if seen_ends >= all_sids:
            print(f"[recv] all {len(all_sids)} streams ended; breaking", file=sys.stderr, flush=True)
            break

    # Report
    rows = []
    for sid, (svc, verb, path) in streams.items():
        st = stream_state.get(sid, {})
        if st.get("reset"):
            rows.append({"service": svc, "verb": verb, "path": path, "status": "RESET",
                         "reset_code": st["reset"][0], "reset_reason": st["reset"][1]})
            print(f"  {svc:9s} {verb:4s} {path:40s} -> RESET code={st['reset'][0]} {st['reset'][1]!r}")
            continue
        status = st.get("status")
        body = bytes(st.get("body", b""))
        preview = body[:120].decode("utf-8", errors="replace")
        rows.append({"service": svc, "verb": verb, "path": path, "status": status,
                     "headers": st.get("headers", []), "body_len": len(body),
                     "body_text": preview, "body_hex_head": body[:60].hex()})
        if status is None:
            print(f"  {svc:9s} {verb:4s} {path:40s} -> (no response)")
        else:
            print(f"  {svc:9s} {verb:4s} {path:40s} -> {status}  len={len(body):5d}  body={preview!r}")

    (out_dir / "results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")

    # Highlight 200s
    print("\n=== 200 OK summary ===")
    for r in rows:
        if r.get("status") == 200:
            print(f"  {r['service']:9s} {r['verb']:4s} {r['path']:40s} len={r.get('body_len',0)}  body={r.get('body_text','')[:160]!r}")

    print(f"\n[done] saved {out_dir}/results.json")
    ws.close()


if __name__ == "__main__":
    main()

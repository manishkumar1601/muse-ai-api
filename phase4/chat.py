"""End-to-end chat client for muse.ai (Hatch).

Flow:
    1. Noise XX handshake            (phase 2)
    2. POST /chat/subscribe          (phase 5 — register as streaming subscriber on THIS connection)
    3. POST /chat/stream             (phase 4 — send the user message)
    4. Collect pushed events on new stream_ids
    5. Assemble delta.text_append -> final reply
    6. Return on delta.message_done

Usage:
    python chat.py "your message"
    python chat.py --message "..." --listen-seconds 45
"""

import argparse
import collections
import json
import secrets
import sys
import time
import uuid
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

CAPABILITIES = ["chat_cancel", "delta_stream", "custom_reactions",
                "custom_reactions_facebook_thumbs_up_v1"]


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
    return pair


class HatchClient:
    """One Noise channel to one Hatch VM. Keeps a monotonic stream_id/chunk_id and demuxes
    inbound frames by stream_id. Not thread-safe."""

    def __init__(self, session_path: str = "../phase1/session.json"):
        sess = json.loads(Path(session_path).read_text("utf-8"))
        self.M = load_pool()
        cc = cc_requests.Session(impersonate="chrome")
        cc.headers.update({
            "User-Agent": UA,
            "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "Origin": "https://muse.ai",
        })
        self.ws = cc.ws_connect(sess["ws_url"], timeout=15)
        try: self.ws.curl.setopt(self.ws.curl.TIMEOUT_MS, 1500)
        except Exception: pass
        (self.cs_send, self.cs_recv) = noise_handshake(self.ws)
        self._stream_id = 0
        self._chunk_id = 0
        self._tx_assemblies: dict = {}
        self._stream_bodies = collections.defaultdict(lambda: {"status": None, "body": bytearray(), "ended": False, "svc_stream_id": None})
        self._pending_recv: list = []  # drained parsed frames awaiting consumer

    # ---- send -----
    def _next_ids(self) -> tuple[int, int]:
        self._stream_id += 1
        self._chunk_id += 1
        return self._stream_id, self._chunk_id

    # Max Noise transport payload size we observed; split larger ServiceRequests across chunks.
    MAX_CHUNK_PAYLOAD = 48 * 1024

    def request(self, verb: str, path: str, body=None,
                headers=((" content-type", "application/json"), ("accept-language", "en-US"))) -> int:
        """Fire-and-forget. Returns the stream_id."""
        sid, cid = self._next_ids()
        body_bytes = json.dumps(body).encode() if body is not None else b""
        hdr_msgs = [self.M["Header"](key=k.strip(), value=v) for k, v in headers if body_bytes or k.strip() != "content-type"]
        req = self.M["ApplicationRequest"](verb=verb, path=path, headers=hdr_msgs, body=body_bytes, end_body=True)
        sf = self.M["ServiceFrame"](stream_id=sid, request=req)
        sr_bytes = self.M["ServiceRequest"](
            service=self.M["_svc"]["SERVICE_DAEMON"], payload=sf.SerializeToString(),
        ).SerializeToString()
        # Chunk the ServiceRequest bytes across NoiseTransportFrame chunks if large.
        parts = [sr_bytes[i:i + self.MAX_CHUNK_PAYLOAD] for i in range(0, len(sr_bytes) or 1, self.MAX_CHUNK_PAYLOAD)] or [b""]
        total = len(parts)
        for idx, part in enumerate(parts):
            tx = self.M["NoiseTransportFrame"](chunk_id=cid, chunk_index=idx, total_chunks=total, payload=part)
            self.ws.send(self.cs_send.encrypt_with_ad(b"", tx.SerializeToString()), flags=CurlWsFlag.BINARY)
        return sid

    # ---- receive -----
    def _recv_one(self):
        """Yields one of:
             (sid, "event", json_obj)   — a single body_chunk delivering a self-contained JSON event
             (sid, "complete", {status, obj}) — end_body=True seen; final assembled body
             (sid, "reset", {code, reason})
             None on timeout, "closed" on CLOSE
        For long-lived subscription streams (e.g. /chat/subscribe), each body_chunk is one JSON
        event and gets emitted immediately; the stream never ends.
        """
        try:
            frame, flag = self.ws.recv()
        except Exception as e:
            msg = str(e).lower()
            if "timeout" in msg or "again" in msg: return None
            raise
        if not frame or flag & CurlWsFlag.CLOSE:
            return "closed"
        try: pt = self.cs_recv.decrypt_with_ad(b"", frame)
        except Exception: return None
        try:
            txf = self.M["NoiseTransportFrame"](); txf.ParseFromString(pt)
        except Exception: return None
        buf = self._tx_assemblies.setdefault(txf.chunk_id, {"chunks": {}, "total": txf.total_chunks})
        buf["chunks"][txf.chunk_index] = txf.payload
        if len(buf["chunks"]) < buf["total"]: return None
        payload = b"".join(buf["chunks"][i] for i in range(buf["total"]))
        self._tx_assemblies.pop(txf.chunk_id)
        try:
            sr = self.M["ServiceResponse"](); sr.ParseFromString(payload)
            sf = self.M["ServiceFrame"](); sf.ParseFromString(sr.payload)
        except Exception:
            return None
        sid = sf.stream_id
        kind = sf.WhichOneof("kind")
        if kind == "reset":
            self._stream_bodies.pop(sid, None)
            return (sid, "reset", {"code": sf.reset.code, "reason": sf.reset.reason})
        bucket = self._stream_bodies[sid]
        if kind == "response":
            bucket["status"] = sf.response.status
            if sf.response.body: bucket["body"].extend(sf.response.body)
            if sf.response.end_body:
                raw = bytes(bucket["body"]); self._stream_bodies.pop(sid, None)
                try: obj = json.loads(raw.decode("utf-8")) if raw else {}
                except Exception: obj = {"_raw": raw.decode("utf-8", errors="replace")}
                return (sid, "complete", {"status": bucket["status"], "obj": obj})
            return None
        if kind == "body_chunk":
            data = sf.body_chunk.data
            if data:
                # Try to parse as a self-contained JSON event (subscribe streams)
                try:
                    obj = json.loads(data.decode("utf-8"))
                    # If it looks like an event (has "event" key), emit as event immediately
                    if isinstance(obj, dict) and "event" in obj:
                        return (sid, "event", obj)
                except Exception:
                    pass
                bucket["body"].extend(data)
            if sf.body_chunk.end_body:
                raw = bytes(bucket["body"]); self._stream_bodies.pop(sid, None)
                try: obj = json.loads(raw.decode("utf-8")) if raw else {}
                except Exception: obj = {"_raw": raw.decode("utf-8", errors="replace")}
                return (sid, "complete", {"status": bucket["status"], "obj": obj})
            return None
        return None

    # Back-compat shim
    def _recv_one_assembled(self):
        return self._recv_one()

    def collect_until(self, pred, deadline_s: float):
        """Pull frames until pred(stream_id, kind, obj) returns True or deadline."""
        deadline = time.time() + deadline_s
        while time.time() < deadline:
            got = self._recv_one_assembled()
            if got is None: continue
            if got == "closed": return
            sid, kind, obj = got
            if pred(sid, kind, obj): return

    def close(self):
        try: self.ws.close()
        except Exception: pass


def send_and_collect_reply(user_text: str, timezone: str, listen_seconds: int,
                            session_path: str, save_events: str | None = None,
                            client_id: str | None = None) -> dict:
    client = HatchClient(session_path=session_path)
    client_id = client_id or str(uuid.uuid4())
    try:
        # 0. Register our client_id — server routes pushed events to the registered connection
        reg_sid = client.request("POST", "/client/register-capabilities", body={
            "client_id": client_id,
            "platform": "web",
            "display_name": "Muse Reverse Client",
            "version": "0.0.0",
            "capabilities": {
                "data_sources": {},
                "device_commands": {},
                "hatch_app_commands": {},
                "rendering": {"supported_presentations": ["file", "image", "video", "audio",
                              "slides", "html", "letter", "idea", "idea_group", "external_link",
                              "text_with_button", "generic_list"],
                              "supported_inline_presentations": ["option"],
                              "supported_text_entities": []},
            },
        })

        # 1. Subscribe to the chat event stream
        sub_sid = client.request("POST", "/chat/subscribe", body={
            "after_stream_seq": 0, "after_chat_event_seq": 0, "capabilities": CAPABILITIES,
        })

        send_start_ms = int(time.time() * 1000)

        # 2. Send the user message. node_id = our registered client_id (observed in browser).
        send_sid = client.request("POST", "/chat/stream", body={
            "message": user_text,
            "node_id": client_id,
            "capabilities": CAPABILITIES,
            "timezone": timezone,
        })
        print(f"[send] reg={reg_sid} sub={sub_sid} send={send_sid} client_id={client_id} msg={user_text!r}", file=sys.stderr, flush=True)

        # 3. Collect — stop when we see delta.message_done OR agent.status=online after we have text
        events: list = []
        text_parts: list[str] = []
        ack_body = None
        got_done = False
        got_text = False

        def extract_text_from_transcript(payload):
            """delta.message_done payload.transcript.messages[*].content[*].text"""
            parts = []
            for m in (payload.get("transcript", {}).get("messages", []) or []):
                for c in (m.get("content", []) or []):
                    if c.get("type") == "text" and c.get("text"):
                        parts.append(c["text"])
            return "".join(parts)

        def consume(sid, kind, obj):
            nonlocal ack_body, got_done
            if kind == "reset":
                print(f"[reset {sid}] {obj}", file=sys.stderr, flush=True); return False
            if kind == "complete":
                body = obj.get("obj", {})
                if sid == send_sid and isinstance(body, dict) and "message_id" in body:
                    ack_body = body
                    print(f"[ack ] {body.get('message_id')}", file=sys.stderr, flush=True)
                return False
            if kind != "event":
                return False
            ts_ms = obj.get("ts_ms", 0)
            # Ignore catch-up events emitted during subscribe replay
            if ts_ms and ts_ms < send_start_ms:
                return False
            events.append(obj)
            ev = obj.get("event", "")
            payload = obj.get("payload", {}) or {}
            if ev == "delta.text_append":
                t = payload.get("text") or payload.get("delta") or ""
                text_parts.append(t)
                sys.stderr.write(t); sys.stderr.flush()
            elif ev == "delta.message_done":
                # The server also may emit done without a prior delta.text_append (full text in transcript)
                full_text = extract_text_from_transcript(payload)
                if full_text and not text_parts:
                    text_parts.append(full_text)
                got_done = True
                print(f"\n[end ] delta.message_done  message_id={payload.get('message_id','')}", file=sys.stderr, flush=True)
                return True
            else:
                print(f"[event] {ev}", file=sys.stderr, flush=True)
            return False

        client.collect_until(consume, listen_seconds)

        reply_text = "".join(text_parts)
        result = {"ok": True, "ack": ack_body, "reply": reply_text, "events": events, "done": got_done}
        if save_events:
            Path(save_events).write_text(json.dumps(events, indent=2), encoding="utf-8")
            print(f"[saved] {len(events)} events -> {save_events}", file=sys.stderr)
        return result
    finally:
        client.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("message", nargs="?", default=None)
    ap.add_argument("--message", dest="msg_flag", default=None)
    ap.add_argument("--session", default="../phase1/session.json")
    ap.add_argument("--timezone", default="Asia/Calcutta")
    ap.add_argument("--listen-seconds", type=int, default=45)
    ap.add_argument("--save-events", default=None)
    args = ap.parse_args()

    user_text = args.message or args.msg_flag
    if not user_text:
        print("usage: python chat.py \"your message\"", file=sys.stderr); sys.exit(2)

    r = send_and_collect_reply(user_text, args.timezone, args.listen_seconds,
                                args.session, args.save_events)
    reply = r.get("reply") or ""
    print(f"\n--- reply ({len(reply)} chars) ---\n{reply}")


if __name__ == "__main__":
    main()

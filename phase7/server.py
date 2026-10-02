"""Phase 7 — OpenAI-compatible AND Anthropic-compatible HTTP server backed by muse.ai.

Exposes TWO shapes of the same underlying model (Muse Spark via the Hatch agent):

  POST /v1/chat/completions          OpenAI chat completions (stream + non-stream)
  POST /v1/messages                  Anthropic messages (stream + non-stream)
  GET  /v1/models                    OpenAI model list (returns one entry)
  GET  /healthz                      liveness

Auth: pass a key in `Authorization: Bearer <key>` matching MUSE_PROXY_KEY env var.
    If MUSE_PROXY_KEY is unset the server runs open (for localhost dev).

Usage:
    pip install -r requirements.txt
    python -m uvicorn server:app --host 127.0.0.1 --port 8787
    # Then: OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=anything  <your tool>
    #       ANTHROPIC_BASE_URL=http://127.0.0.1:8787  ANTHROPIC_API_KEY=anything  <your tool>
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

# Import the Hatch client we built in Phase 4
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phase4"))
from chat import HatchClient, CAPABILITIES  # type: ignore

MODEL_NAME = os.environ.get("MUSE_PROXY_MODEL", "muse-spark")
SESSION_PATH = os.environ.get("MUSE_SESSION_PATH",
                              str(Path(__file__).resolve().parents[1] / "phase1" / "session.json"))
BOOTSTRAP_SCRIPT = Path(__file__).resolve().parents[1] / "phase1" / "bootstrap.py"
API_KEY = os.environ.get("MUSE_PROXY_KEY")  # optional
DEFAULT_TZ = os.environ.get("MUSE_TZ", "Asia/Calcutta")

app = FastAPI(title="muse.ai → OpenAI/Anthropic bridge", version="0.1.0")


# ---- auth -----
def _check_auth(authorization: str | None, x_api_key: str | None):
    if not API_KEY:
        return
    presented = None
    if authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    elif x_api_key:
        presented = x_api_key.strip()
    if presented != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# ---- Hatch invocation -----
def _refresh_session():
    """Re-run phase1 bootstrap.py to mint a fresh session.json. Best-effort."""
    try:
        subprocess.run([sys.executable, str(BOOTSTRAP_SCRIPT),
                        "--out", SESSION_PATH],
                       cwd=str(BOOTSTRAP_SCRIPT.parent), check=True, timeout=60)
        return True
    except Exception as e:
        print(f"[server] bootstrap refresh failed: {e}", file=sys.stderr)
        return False


def _extract_user_text(messages: list[dict]) -> str:
    """Flatten the OpenAI/Anthropic message list into one user prompt. Simple strategy:
    concatenate every message with role prefix; the Hatch agent sees it all as one turn."""
    out = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            # Anthropic content blocks
            text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
        else:
            text = str(content)
        if not text.strip():
            continue
        if role == "system":
            out.append(f"[system]\n{text}")
        elif role == "assistant":
            out.append(f"[assistant previous turn]\n{text}")
        else:
            out.append(text)
    return "\n\n".join(out)


async def _run_hatch(user_text: str, timezone: str, listen_s: int,
                      stream_cb=None) -> dict:
    """Run the Hatch chat round-trip in a thread so FastAPI's event loop stays free.
    stream_cb(delta: str) called per text append if provided."""
    loop = asyncio.get_running_loop()
    reply_parts: list[str] = []
    ack = {"message_id": None}
    client_id = str(uuid.uuid4())

    def do_sync():
        # One fresh Noise session per request. If session.json is stale, try one refresh.
        for attempt in range(2):
            try:
                client = HatchClient(session_path=SESSION_PATH)
                break
            except Exception as e:
                print(f"[server] HatchClient open attempt {attempt+1} failed: {e}", file=sys.stderr)
                if attempt == 0 and _refresh_session():
                    continue
                raise

        try:
            client.request("POST", "/client/register-capabilities", body={
                "client_id": client_id, "platform": "web", "display_name": "muse-proxy",
                "version": "0.0.0",
                "capabilities": {"data_sources": {}, "device_commands": {},
                                 "hatch_app_commands": {},
                                 "rendering": {"supported_presentations": ["text_with_button", "generic_list"],
                                               "supported_inline_presentations": ["option"],
                                               "supported_text_entities": []}},
            })
            client.request("POST", "/chat/subscribe", body={
                "after_stream_seq": 0, "after_chat_event_seq": 0, "capabilities": CAPABILITIES,
            })
            send_start_ms = int(time.time() * 1000)
            send_sid = client.request("POST", "/chat/stream", body={
                "message": user_text, "node_id": client_id,
                "capabilities": CAPABILITIES, "timezone": timezone,
            })
            got_done = False
            deadline = time.time() + listen_s
            while time.time() < deadline and not got_done:
                r = client._recv_one()
                if r is None: continue
                if r == "closed": break
                sid, kind, obj = r
                if kind == "complete" and sid == send_sid and isinstance(obj, dict):
                    body = obj.get("obj", {})
                    if isinstance(body, dict) and "message_id" in body:
                        ack["message_id"] = body["message_id"]
                    continue
                if kind != "event": continue
                ts_ms = obj.get("ts_ms", 0)
                if ts_ms and ts_ms < send_start_ms: continue
                ev = obj.get("event", "")
                payload = obj.get("payload", {}) or {}
                if ev == "delta.text_append":
                    t = payload.get("text") or payload.get("delta") or ""
                    if t:
                        reply_parts.append(t)
                        if stream_cb:
                            loop.call_soon_threadsafe(stream_cb, t)
                elif ev == "delta.message_done":
                    if not reply_parts:
                        for m in payload.get("transcript", {}).get("messages", []) or []:
                            for c in m.get("content", []) or []:
                                if c.get("type") == "text" and c.get("text"):
                                    reply_parts.append(c["text"])
                                    if stream_cb:
                                        loop.call_soon_threadsafe(stream_cb, c["text"])
                    got_done = True
        finally:
            client.close()

    await asyncio.get_running_loop().run_in_executor(None, do_sync)
    return {"text": "".join(reply_parts), "message_id": ack["message_id"] or str(uuid.uuid4())}


# ======== OpenAI compat ========

def _openai_resp(reply_text: str, message_id: str, model: str) -> dict:
    now = int(time.time())
    return {
        "id": f"chatcmpl-{message_id}", "object": "chat.completion", "created": now, "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": reply_text},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _openai_stream_chunk(reply_text: str, message_id: str, model: str, finish: str | None) -> dict:
    now = int(time.time())
    delta = {"content": reply_text} if reply_text else {}
    if finish is None and not reply_text:
        delta = {"role": "assistant", "content": ""}
    return {
        "id": f"chatcmpl-{message_id}", "object": "chat.completion.chunk", "created": now, "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


@app.post("/v1/chat/completions")
async def openai_chat_completions(req: Request,
                                   authorization: str | None = Header(None),
                                   x_api_key: str | None = Header(None, alias="x-api-key")):
    _check_auth(authorization, x_api_key)
    body = await req.json()
    user_text = _extract_user_text(body.get("messages", []))
    if not user_text.strip():
        raise HTTPException(400, "no non-empty user message")
    model = body.get("model") or MODEL_NAME
    stream = bool(body.get("stream"))

    if not stream:
        r = await _run_hatch(user_text, DEFAULT_TZ, listen_s=60)
        return _openai_resp(r["text"], r["message_id"], model)

    # Streaming
    queue: asyncio.Queue = asyncio.Queue()
    message_id = str(uuid.uuid4())

    def on_delta(t: str):
        queue.put_nowait(t)

    async def runner():
        try:
            r = await _run_hatch(user_text, DEFAULT_TZ, listen_s=60, stream_cb=on_delta)
            if r["message_id"]: queue.put_nowait(("__id__", r["message_id"]))
        except Exception as e:
            queue.put_nowait(("__err__", str(e)))
        queue.put_nowait(None)

    asyncio.create_task(runner())

    async def gen() -> AsyncGenerator[bytes, None]:
        # first chunk: role
        yield f"data: {json.dumps(_openai_stream_chunk('', message_id, model, None))}\n\n".encode()
        resolved_id = message_id
        while True:
            item = await queue.get()
            if item is None: break
            if isinstance(item, tuple):
                if item[0] == "__id__": resolved_id = item[1]
                elif item[0] == "__err__":
                    yield f"data: {json.dumps({'error': {'message': item[1]}})}\n\n".encode(); break
                continue
            yield f"data: {json.dumps(_openai_stream_chunk(item, resolved_id, model, None))}\n\n".encode()
        yield f"data: {json.dumps(_openai_stream_chunk('', resolved_id, model, 'stop'))}\n\n".encode()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/v1/models")
async def openai_models(authorization: str | None = Header(None),
                         x_api_key: str | None = Header(None, alias="x-api-key")):
    _check_auth(authorization, x_api_key)
    return {"object": "list", "data": [{
        "id": MODEL_NAME, "object": "model", "created": int(time.time()), "owned_by": "muse-proxy",
    }]}


# ======== Anthropic compat ========

def _anthropic_resp(reply_text: str, message_id: str, model: str) -> dict:
    return {
        "id": f"msg_{message_id}", "type": "message", "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": reply_text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


@app.post("/v1/messages")
async def anthropic_messages(req: Request,
                              authorization: str | None = Header(None),
                              x_api_key: str | None = Header(None, alias="x-api-key")):
    _check_auth(authorization, x_api_key)
    body = await req.json()
    system = body.get("system", "")
    msgs = list(body.get("messages", []))
    if isinstance(system, str) and system.strip():
        msgs = [{"role": "system", "content": system}] + msgs
    user_text = _extract_user_text(msgs)
    if not user_text.strip():
        raise HTTPException(400, "no non-empty user message")
    model = body.get("model") or MODEL_NAME
    stream = bool(body.get("stream"))

    if not stream:
        r = await _run_hatch(user_text, DEFAULT_TZ, listen_s=60)
        return _anthropic_resp(r["text"], r["message_id"], model)

    # Anthropic SSE format:  event: <name>\ndata: {...}\n\n
    queue: asyncio.Queue = asyncio.Queue()
    message_id = str(uuid.uuid4())

    def on_delta(t: str):
        queue.put_nowait(t)

    async def runner():
        try:
            r = await _run_hatch(user_text, DEFAULT_TZ, listen_s=60, stream_cb=on_delta)
            if r["message_id"]: queue.put_nowait(("__id__", r["message_id"]))
        except Exception as e:
            queue.put_nowait(("__err__", str(e)))
        queue.put_nowait(None)

    asyncio.create_task(runner())

    async def gen() -> AsyncGenerator[bytes, None]:
        resolved_id = message_id
        def sse(event: str, data: dict) -> bytes:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
        yield sse("message_start", {
            "type": "message_start",
            "message": {"id": f"msg_{resolved_id}", "type": "message", "role": "assistant",
                        "content": [], "model": model,
                        "stop_reason": None, "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0}},
        })
        yield sse("content_block_start", {
            "type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""},
        })
        total = 0
        while True:
            item = await queue.get()
            if item is None: break
            if isinstance(item, tuple):
                if item[0] == "__id__": resolved_id = item[1]
                elif item[0] == "__err__":
                    yield sse("error", {"type": "error", "error": {"type": "api_error", "message": item[1]}}); break
                continue
            total += len(item)
            yield sse("content_block_delta", {
                "type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": item},
            })
        yield sse("content_block_stop", {"type": "content_block_stop", "index": 0})
        yield sse("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": total},
        })
        yield sse("message_stop", {"type": "message_stop"})

    return StreamingResponse(gen(), media_type="text/event-stream")


# ======== plumbing ========

@app.post("/v1/messages/count_tokens")
async def anthropic_count_tokens(req: Request,
                                   authorization: str | None = Header(None),
                                   x_api_key: str | None = Header(None, alias="x-api-key")):
    _check_auth(authorization, x_api_key)
    body = await req.json()
    # Hatch does not expose tokenizer. Fake a 1-token-per-4-chars estimate.
    def text_of(msgs):
        total = 0
        for m in msgs or []:
            c = m.get("content", "")
            if isinstance(c, list):
                for b in c: total += len(b.get("text", ""))
            else: total += len(str(c))
        return total
    chars = text_of(body.get("messages")) + len(body.get("system") or "")
    return {"input_tokens": max(1, chars // 4)}


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": MODEL_NAME, "session_path": SESSION_PATH,
            "session_exists": Path(SESSION_PATH).exists()}


@app.get("/")
async def root():
    return {"service": "muse-proxy", "openai": "/v1/chat/completions",
            "anthropic": "/v1/messages", "count_tokens": "/v1/messages/count_tokens",
            "models": "/v1/models", "health": "/healthz"}


# Log every request path for debugging
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    print(f"[req ] {request.method} {request.url.path}", file=sys.stderr, flush=True)
    resp = await call_next(request)
    print(f"[resp] {request.method} {request.url.path} {resp.status_code} ({(time.time()-start)*1000:.0f}ms)",
          file=sys.stderr, flush=True)
    return resp

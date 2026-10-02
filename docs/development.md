# Development — extending the project

## Project layout

```
muse-ai-api/
├── README.md            top-level entry point
├── .gitignore           secrets gate (session.json, storage_state.json, ...)
├── memory/              dated session logs (why things are the way they are)
├── docs/                reference (how things work, how to use)
├── recon/               phase 0 — captured JS chunks + descriptors + reports
├── phase1/              bootstrap.py — HTTP cookie bootstrap
├── phase2/              handshake.py + extract_protos.py
│   └── protos/          5 extracted FileDescriptorProto .binpb files
├── phase3/              decode_descriptors.py + probe.py + sweep.py
├── phase4/              chat.py — HatchClient class + end-to-end chat flow
└── phase7/              server.py — OpenAI + Anthropic compat FastAPI proxy
```

## Set up on a fresh machine

```bash
git clone git@github.com:manishkumar1601/muse-ai-api.git
cd muse-ai-api

python -m venv .venv
.venv\Scripts\activate     # or source .venv/bin/activate

pip install -r phase7/requirements.txt    # supersets all other phase deps

# One-time: dump your logged-in muse.ai cookies via Playwright
# (or any tool that produces Playwright storage_state format)
# Save to phase1/storage_state.json

python phase1/bootstrap.py                # produces phase1/session.json
python -m uvicorn phase7.server:app --app-dir phase7 --host 127.0.0.1 --port 8787
```

## Adding a new DAEMON endpoint call

1. Confirm the endpoint exists:
   ```powershell
   Set-Content -Path phase3/probes.json -Value '[["DAEMON","GET","/your-path",null]]' -Encoding ascii
   python phase3/sweep.py --probes phase3/probes.json --listen-seconds 10
   ```
2. If 400, iterate on body shape — the server's error messages tell you what's missing.
3. Add a method on `HatchClient` (or just call `client.request(verb, path, body)` directly).
4. If large bodies (>65KB) might be sent, no extra work needed — `request()` already chunks.

## Adding a new event type to the proxy

Current proxy handles `delta.text_append` and `delta.message_done`. To surface more:

1. Capture a session with `events.json` via `python phase4/chat.py --save-events out.json "test"`.
2. Grep for event types: `jq -r '.[].event' out.json | sort -u`.
3. In `phase7/server.py:_run_hatch` → add a branch in the event loop.
4. For OpenAI SSE: encode as a `chat.completion.chunk` with your payload inside `delta`. For Anthropic SSE: use `content_block_delta` or a custom event name.

## Capturing fresh browser traffic (if things break)

```python
# From Playwright MCP or your own Playwright script:
await page.addInitScript({ content: """
(() => {
  if (self.__cryptoPatched) return;
  self.__cryptoPatched = true;
  self.__cryptoLog = [];
  const where = (typeof window !== 'undefined' && window === self) ? 'main' : 'worker';
  const bc = new BroadcastChannel('__cryptoSpy');
  if (where === 'main') bc.onmessage = (ev) => self.__cryptoLog.push(ev.data);
  const log = (ev) => { try { bc.postMessage(ev); } catch(e){} if (where==='main') self.__cryptoLog.push(ev); };
  const oe = crypto.subtle.encrypt.bind(crypto.subtle);
  const od = crypto.subtle.decrypt.bind(crypto.subtle);
  crypto.subtle.encrypt = async function(algo, key, data) {
    if ((algo?.name||algo) === 'AES-GCM') {
      const b = data instanceof ArrayBuffer ? new Uint8Array(data)
                                             : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      log({dir:'enc', len:b.length, hex:[...b.slice(0,4096)].map(x=>x.toString(16).padStart(2,'0')).join(''), from:where, t:Date.now()});
    }
    return oe(algo, key, data);
  };
  crypto.subtle.decrypt = async function(algo, key, data) {
    const r = await od(algo, key, data);
    if ((algo?.name||algo) === 'AES-GCM') {
      const b = new Uint8Array(r);
      log({dir:'dec', len:b.length, hex:[...b.slice(0,4096)].map(x=>x.toString(16).padStart(2,'0')).join(''), from:where, t:Date.now()});
    }
    return r;
  };
})();
""" });
```

Then in the browser DevTools: `copy(JSON.stringify(window.__cryptoLog))` and paste into a file. Each entry has the plaintext hex of one AES-GCM encrypt/decrypt call. Search by ASCII-marker-as-hex (`'HELLO' → '48454c4c4f'`) to find your test message.

## Re-extracting protobuf schemas

If Meta changes the Noise or envelope protos:

```bash
# Download all chunks (one-time; just needs the URLs saved from last run)
# Then:
python phase2/extract_protos.py --chunks recon/chunks --out phase2/protos
python phase3/decode_descriptors.py           # regenerates docs/-grade .proto source
```

If a new `fileDesc("...")` form appears (different mangled call pattern), update the regex in `extract_protos.py:FILE_DESC_RE`.

## Common debugging workflow

1. **Enable server request logging** — already on by default in `phase7/server.py` middleware.
2. **Save events to disk** — pass `--save-events events.json` to `phase4/chat.py` or add an equivalent in the proxy.
3. **Hex-dump a decrypted frame** — in `phase4/chat.py:_recv_one`, add a `print(pt[:60].hex())` before parsing.
4. **Compare to the browser** — rerun the browser capture (above) and diff plaintexts.

## Running the test probes

```bash
# Phase 1 — unit test
python phase1/bootstrap.py --self-check

# Phase 2 — Noise state math (no network)
python phase2/handshake.py --self-check

# Phase 2 — live handshake + record frames
python phase2/handshake.py --listen-seconds 10

# Phase 3 — HTTP route sweep
python phase3/sweep.py --listen-seconds 15

# Phase 4 — one chat round-trip
python phase4/chat.py "hi" --listen-seconds 30

# Phase 7 — server smoke test
python -m uvicorn phase7.server:app --app-dir phase7 --port 8787 &
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/v1/models
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}'
```

## Code style

- No tests except per-script `--self-check` for pure functions. The whole project is a research dump.
- Comments mostly explain _why_, not _what_. Non-obvious invariants get `# ponytail: ...` tags.
- Default to simple over clever. If something looks over-engineered, it probably is — strip it back.

## When Meta ships an update

Likely-first-to-break order (most → least fragile):
1. Chunk-id naming / hashes in `/_next/static/chunks/*.js` — `recon/chunk_urls.txt` goes stale. Just re-fetch.
2. Mangled identifiers in the JS — `extract_protos.py` regex may miss some. Update regex.
3. Protobuf field numbers — would invalidate `phase2/protos/*.binpb`. Re-extract.
4. `/chat/stream` request body shape — add a field, remove a field. Instrument crypto, grep marker, update body.
5. The entire Noise suite / handshake pattern — unlikely but possible. Would require Phase 2 rewrite.
6. The HTTP-over-Noise envelope — unlikely; it's clearly their internal RPC standard.

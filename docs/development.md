# Development — extending the project

## Project layout

```
muse-ai-api/
├── index.ts             entrypoint — starts the Hono server
├── package.json
├── tsconfig.json
├── .gitignore           secrets gate (session.json, storage_state.json, ...)
├── memory/              dated session logs (why things are the way they are)
├── docs/                reference (how things work, how to use)
├── recon/               phase 0 — captured JS chunks + descriptors + reports
└── src/
    ├── config.ts        zod env validation, resolved once at startup
    ├── log.ts           pino child-logger factory
    ├── bootstrap/       session bootstrap (HTTP cookie → session.json)
    │   ├── cookies.ts   Playwright storage_state loader
    │   ├── scrape-vm.ts HTML scraper for activeGatewayUrl fallback
    │   └── session.ts   four-POST bootstrap flow (cycletls)
    ├── noise/           hand-rolled Noise XX (@noble/*)
    │   ├── handshake.ts 3-message XX state machine
    │   ├── cipher.ts    AES-GCM encrypt/decrypt
    │   ├── curve.ts     X25519 DH helpers
    │   ├── symmetric.ts MixHash / MixKey / HKDF
    │   └── util.ts      concat / split helpers
    ├── proto/           protobuf glue
    │   ├── loader.ts    Root.fromDescriptor() over *.binpb files
    │   ├── types.ts     hand-typed TS shapes for runtime-used messages
    │   └── schemas/     5 FileDescriptorProto .binpb blobs
    ├── hatch/           HTTP-over-Noise client + chat flow
    │   ├── client.ts    HatchClient (connect, request, _recvOne, collectUntil)
    │   ├── transport.ts NoiseTransportFrame encode/decode + 48KB chunker
    │   ├── envelope.ts  ServiceRequest / ServiceFrame encode/decode
    │   ├── chat.ts      sendAndCollectReply (register → subscribe → stream)
    │   └── tls.ts       cycletls wrapper (getTls)
    ├── server/          Hono proxy
    │   ├── start.ts     server bootstrap, port binding
    │   ├── handler.ts   shared HatchClient lifecycle + retry logic
    │   ├── openai.ts    POST /v1/chat/completions + GET /v1/models
    │   ├── anthropic.ts POST /v1/messages + POST /v1/messages/count_tokens
    │   ├── auth.ts      MUSE_PROXY_KEY middleware
    │   ├── middleware.ts request/response logging
    │   ├── common.ts    shared response-shaping helpers
    │   └── sse.ts       SSE helpers for streaming responses
    └── cli/
        └── bootstrap.ts CLI entry for `npm run bootstrap`
```

## Set up on a fresh machine

```bash
git clone git@github.com:manishkumar1601/muse-ai-api.git
cd muse-ai-api

npm install

# One-time: dump your logged-in muse.ai cookies via Playwright
# (or any tool that produces Playwright storage_state format)
# Save to ./storage_state.json

npm run bootstrap        # produces ./session.json
npm start                # starts proxy on 127.0.0.1:8787
```

## Adding a new DAEMON endpoint call

1. Confirm the endpoint exists using the sweep script:
   ```powershell
   Set-Content -Path probes.json -Value '[["DAEMON","GET","/your-path",null]]' -Encoding ascii
   npm run sweep -- --probes probes.json --listen-seconds 10
   ```
2. If 400, iterate on body shape — the server's error messages tell you what's missing.
3. Add a method on `HatchClient` (or just call `client.request(verb, path, body)` directly from `src/hatch/client.ts`).
4. If large bodies (>65KB) might be sent, no extra work needed — `request()` already chunks via `src/hatch/transport.ts`.

## Adding a new event type to the proxy

Current proxy handles `delta.text_append` and `delta.message_done`. To surface more:

1. Capture a session with event logging via `LOG_LEVEL=debug npm start` and inspect the pino output.
2. Grep for event types in the debug output: look for `"event":` fields.
3. In `src/hatch/chat.ts:sendAndCollectReply` → add a branch in the event-collection loop.
4. For OpenAI SSE: encode as a `chat.completion.chunk` with your payload inside `delta`. For Anthropic SSE: use `content_block_delta` or a custom event name.

## Capturing fresh browser traffic (if things break)

```js
// From Playwright MCP or your own Playwright script:
await page.addInitScript({ content: `
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
` });
```

Then in the browser DevTools: `copy(JSON.stringify(window.__cryptoLog))` and paste into a file. Each entry has the plaintext hex of one AES-GCM encrypt/decrypt call. Search by ASCII-marker-as-hex (`'HELLO' → '48454c4c4f'`) to find your test message.

## Re-extracting protobuf schemas

If Meta changes the Noise or envelope protos:

```bash
# Download all chunks (one-time; just needs the URLs saved from last run)
# Then run the extraction script:
node scripts/extract-protos.mjs --chunks recon/chunks --out src/proto/schemas

# Verify the new binpb files load correctly:
node -e "import('./src/proto/loader.js').then(m => m.loadPool()).then(() => console.log('ok'))"
```

If a new `fileDesc("...")` form appears (different mangled call pattern), update the regex in `scripts/extract-protos.mjs`.

## Common debugging workflow

1. **Enable verbose logging** — set `LOG_LEVEL=debug` before starting: `LOG_LEVEL=debug npm start`.
2. **Inspect raw frames** — in `src/hatch/transport.ts:decodeFrame`, add a `log.debug({ hex: buf.slice(0,60).toString('hex') }, 'raw frame')`.
3. **Hex-dump a decrypted frame** — in `src/noise/handshake.ts`, log `pt.slice(0,60).toString('hex')` before parsing.
4. **Compare to the browser** — rerun the browser capture (above) and diff plaintexts.

## Running the tests

```bash
# Unit tests (no network — mocked)
npm test

# Server smoke test (requires session.json)
npm start &
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/v1/models
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"muse-spark","messages":[{"role":"user","content":"hi"}]}'
```

## Code style

- No test framework — `node --test` built-in runner with mocks. One test file per module.
- Comments mostly explain _why_, not _what_. Non-obvious invariants get `// ponytail: ...` tags.
- Default to simple over clever. If something looks over-engineered, it probably is — strip it back.

## When Meta ships an update

Likely-first-to-break order (most → least fragile):
1. Chunk-id naming / hashes in `/_next/static/chunks/*.js` — `recon/chunk_urls.txt` goes stale. Just re-fetch.
2. Mangled identifiers in the JS — `scripts/extract-protos.mjs` regex may miss some. Update regex.
3. Protobuf field numbers — would invalidate `src/proto/schemas/*.binpb`. Re-extract.
4. `/chat/stream` request body shape — add a field, remove a field. Instrument crypto, grep marker, update body.
5. The entire Noise suite / handshake pattern — unlikely but possible. Would require `src/noise/` rewrite.
6. The HTTP-over-Noise envelope — unlikely; it's clearly their internal RPC standard.

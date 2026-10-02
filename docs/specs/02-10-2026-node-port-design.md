# Node.js port — design spec (2026-10-02)

## Purpose

Replace the Python phase1/-phase7/ implementation with a single TypeScript project rooted at `index.ts`, keeping byte-for-byte wire-protocol parity with the existing Python code while producing cleaner project structure, strict typing on the wire format, and a one-command developer experience (`npm start`).

## Non-goals

- Multi-user hosting, authn beyond a shared `MUSE_PROXY_KEY`.
- Noise connection pooling (fresh session per request matches Python; add later if measured need).
- Real token counts in `usage` (Hatch doesn't expose a tokenizer).
- Request cancellation on client disconnect (add if a caller complains).
- Image / widget / `delta.presentation` surfacing to the OpenAI/Anthropic clients.
- Attestation chain verification (same deferred decision as Python).

## Behavioural parity requirements

Everything in `memory/*.md` and `docs/*.md` describes the behaviour. The Node port must match the Python port on:

1. The 4-call bootstrap flow against `muse.ai` with Chrome TLS impersonation.
2. The `Noise_XX_25519_AESGCM_SHA256` 3-message handshake, including:
   - msg1 payload = `0x0a 0x20` + 32 CSPRNG bytes.
   - msg3 payload = empty for standard VMs.
   - AES-GCM nonce = `0x00 0x00 0x00 0x00` + big-endian u64 counter.
3. NoiseTransportFrame chunking at 48 KB (MAX_CHUNK_PAYLOAD).
4. HTTP-over-Noise `ServiceRequest` / `ServiceResponse` envelope exactly per `phase2/protos/noise_envelope.proto`.
5. Chat flow: `/client/register-capabilities` → `/chat/subscribe` → `/chat/stream`, UUID reused as `client_id` and `node_id`.
6. Streaming reply: parse each `body_chunk` on the subscribe stream as a self-contained JSON event; filter by `ts_ms < send_start_ms` to drop replay; assemble `delta.text_append` and fall back to `delta.message_done.payload.transcript` for short replies.
7. OpenAI and Anthropic surface identical to Phase 7 (same endpoints, same request/response shape, same SSE event names).
8. Auto re-bootstrap on first `HatchClient` open failure.
9. `/v1/messages/count_tokens` stub returning `max(1, chars/4)` (Claude Code probe).

## Non-functional requirements

- Node.js 20 LTS runtime.
- TypeScript strict (`"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- ESM only (`"type": "module"`).
- Zero `any`. Protobuf messages typed via `protobufjs` dynamic lookups cast to generated-shape types we declare locally.
- `tsx` for development (zero-build dev loop); `tsc --noEmit` for CI type-check; optional `npm run build` emits plain `.js` to `dist/`.
- Lint via `tsc` only — no ESLint config to avoid tool sprawl.
- Logging via `pino` (JSON lines).
- Env validation via `zod` at startup.
- One-liner usability per the user ask: `npm start`.

## Dependencies

```json
{
  "dependencies": {
    "@hono/node-server": "^1.x",
    "hono": "^4.x",
    "cycletls": "^2.x",
    "protobufjs": "^8.x",
    "@noble/curves": "^2.x",
    "@noble/ciphers": "^2.x",
    "@noble/hashes": "^1.x",
    "pino": "^9.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^22.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

All pure Node except `cycletls` which bundles a prebuilt Go binary (linux/mac/win × x64/arm64). No native-compilation step required.

## Project layout

```
muse-ai-api/
├── index.ts                   entry: imports and runs src/server/start.ts
├── package.json  tsconfig.json  .env.example  README.md  LICENSE  .gitignore
├── bin/
│   └── muse-proxy             shebang → npx tsx index.ts (optional installable CLI)
├── src/
│   ├── config.ts              env + zod validation + defaults
│   ├── log.ts                 pino factory
│   ├── bootstrap/
│   │   ├── cookies.ts         load storage_state.json
│   │   ├── session.ts         4-call HTTP bootstrap → writes session.json
│   │   └── scrape-vm.ts       fallback: GET / → regex extract activeGatewayUrl
│   ├── noise/
│   │   ├── curve.ts           X25519 wrapper (@noble/curves)
│   │   ├── cipher.ts          AES-GCM CipherState with Noise nonce layout
│   │   ├── symmetric.ts       SymmetricState (mixKey/mixHash/encryptAndHash/split)
│   │   ├── handshake.ts       HandshakeState XX initiator
│   │   └── index.ts           barrel export
│   ├── proto/
│   │   ├── schemas/
│   │   │   ├── attestation_bundle.proto.binpb
│   │   │   ├── noise_envelope.proto.binpb
│   │   │   ├── noise_transport.proto.binpb
│   │   │   ├── plexi_types.proto.binpb
│   │   │   └── revocation_list.proto.binpb
│   │   ├── loader.ts          load → FileDescriptorSet → protobufjs Root
│   │   └── types.ts           hand-typed interfaces for the messages we touch
│   ├── hatch/
│   │   ├── tls.ts             cycletls lifecycle (init/reuse/exit on SIGTERM)
│   │   ├── transport.ts       NoiseTransportFrame + 48 KB chunking
│   │   ├── envelope.ts        ServiceRequest/Response builders
│   │   ├── client.ts          HatchClient class (open WS, handshake, request/recv)
│   │   └── chat.ts            orchestrator: register → subscribe → send → collect
│   ├── server/
│   │   ├── start.ts           Hono app factory + listen
│   │   ├── middleware.ts      request logging, auth, error handler
│   │   ├── sse.ts             SSE helpers for both wire formats
│   │   ├── openai.ts          /v1/chat/completions + /v1/models
│   │   └── anthropic.ts       /v1/messages + /v1/messages/count_tokens
│   └── cli/
│       └── bootstrap.ts       `npm run bootstrap` entry
├── tests/
│   ├── noise.test.ts          hand-rolled Noise against known test vectors
│   ├── proto.test.ts          round-trip serialize/parse one of each message
│   ├── chunking.test.ts       48 KB split/reassemble
│   └── fixtures/              captured handshake bytes from Python for cross-check
├── docs/                      kept — update code snippets to TS
├── memory/                    kept — add 02-10-2026-node-port.md after merge
└── recon/                     kept as reference
```

Deleted: `phase1/`, `phase2/`, `phase3/`, `phase4/`, `phase5/`, `phase7/`. Python code remains discoverable in git history at commit `31bbda2`.

## Public API

### HTTP (Phase 7 parity)
```
POST /v1/chat/completions                 stream + non-stream
GET  /v1/models                           returns {id: "muse-spark"}
POST /v1/messages                         stream + non-stream
POST /v1/messages/count_tokens            stub
GET  /healthz                             liveness
GET  /                                    service info
```

### CLI
```
npm start                 → node --import tsx index.ts    (prod-style run)
npm run dev               → tsx watch index.ts            (dev loop)
npm run bootstrap         → tsx src/cli/bootstrap.ts      (phase1 equivalent)
npm run build             → tsc                           (emits dist/)
npm test                  → node --test tests/*.test.ts
```

### Env vars
```
MUSE_PROXY_KEY           optional bearer / x-api-key
MUSE_PROXY_MODEL         default: "muse-spark"
MUSE_SESSION_PATH        default: "./session.json"
MUSE_STORAGE_STATE_PATH  default: "./storage_state.json"
MUSE_PROXY_PORT          default: 8787
MUSE_PROXY_HOST          default: "127.0.0.1"
MUSE_TZ                  default: "Asia/Calcutta"
LOG_LEVEL                default: "info"
```

## Data contracts

### `session.json` (output of bootstrap, input of server)

```ts
interface Session {
  captured_at: string;        // ISO
  vm_id: string;              // UUID
  gateway_url: string;        // wss://<vm>.metaaivm.com/
  auth_token: string;         // EdDSA JWT
  notary_token: string;       // endorsement.v1.<...>
  request_id: string;         // UUID
  app_id: "hatch-web";
  ws_url: string;             // fully-built wss://hatch.metaaivm.com/v1/noise?...
  lb_host: "hatch.metaaivm.com";
  noise_suite: "Noise_XX_25519_AESGCM_SHA256";
}
```

### Noise XX hand-rolled module API

```ts
export interface CipherState { encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array; decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array; }
export interface SplitResult { send: CipherState; recv: CipherState; handshakeHash: Uint8Array; remoteStatic: Uint8Array; }
export class XxInitiator {
  constructor(prologue?: Uint8Array, staticKey?: Uint8Array);
  writeMessage1(payload: Uint8Array): Uint8Array;    // produces 32 + payload bytes
  readMessage2(msg: Uint8Array): Uint8Array;         // returns decrypted payload
  writeMessage3(payload: Uint8Array): { bytes: Uint8Array; split: SplitResult };
}
```

### Hatch envelope builders

```ts
export function buildApplicationRequest(verb: string, path: string, body?: Uint8Array, headers?: Header[]): Uint8Array;
export function buildServiceRequest(service: ServiceType, serviceFrame: Uint8Array): Uint8Array;
export function buildTransportFrames(chunkId: bigint, sr: Uint8Array, maxChunk: number): Uint8Array[];
```

### HatchClient

```ts
export class HatchClient {
  static open(session: Session, tls: CycleTLSClient): Promise<HatchClient>;
  request(verb: string, path: string, body?: unknown, headers?: Record<string, string>): bigint;  // returns stream_id
  recvOne(timeoutMs?: number): Promise<RecvEvent | null | 'closed'>;
  collectUntil(predicate: (ev: RecvEvent) => boolean, deadlineMs: number): Promise<void>;
  close(): Promise<void>;
}

export type RecvEvent =
  | { kind: 'event';    streamId: bigint; obj: HatchEvent }
  | { kind: 'complete'; streamId: bigint; status: number;  body: unknown }
  | { kind: 'reset';    streamId: bigint; code: number;    reason: string };
```

### Chat orchestrator

```ts
export async function sendAndCollectReply(opts: {
  client: HatchClient;
  userText: string;
  timezone: string;
  listenMs: number;
  onDelta?: (chunk: string) => void;
  clientId?: string;
}): Promise<{ replyText: string; messageId: string; events: HatchEvent[] }>;
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hand-rolled Noise has a bug and server disconnects | Cross-check msg1/msg2/msg3 byte output against Python by running both with the same `secrets.token_bytes` and a captured handshake pair in `tests/fixtures/`. |
| cycletls Go process lingers on crash | Register `process.on('SIGTERM'|'SIGINT'|'uncaughtException', ...)` → `await tls.exit()`. |
| cycletls JA3 string drifts behind Chrome | Pin the string in `src/hatch/tls.ts` as a constant with a comment pointing to the Chrome version source. |
| protobufjs decoder vs Python differences on optional fields | Use the same `FileDescriptorSet` bytes; add a test that round-trips one of each message type and asserts byte equality for a known fixture. |
| Reusing one cycletls instance across concurrent requests | Serialize ws_connect calls behind a mutex OR instantiate per-request (adds cost). Pick serialize-with-mutex. |

## Test strategy

- Unit: Noise state machine against the Noise spec's XX test vectors (plus the `Noise_XX_25519_AESGCM_SHA256` specific set generated once from the Python impl into `tests/fixtures/`).
- Unit: protobuf round-trip for `NoiseTransportFrame`, `ServiceFrame`, `ApplicationRequest`.
- Unit: transport chunking at 48KB boundary (49KB / 50KB / 100KB / 1MB payloads).
- No integration tests — network-dependent + session-expiry-dependent. Keep `tests/README.md` with instructions for manual E2E.

## Migration

1. Create `src/`, `tests/`, port code module by module.
2. Move `phase2/protos/*.binpb` → `src/proto/schemas/`.
3. Keep `docs/`, `memory/`, `recon/` in place. Add `memory/02-10-2026-node-port.md` with the migration note.
4. Delete `phase1/`-`phase7/` as the last step, after `npm start` is proven end-to-end.
5. Update top-level `README.md` to Node-centric instructions, keep the pointer to legacy via git history.
6. Add `index.ts` as the one-liner entry per user's ask.

## Approval gates

Per brainstorming skill: user approves this spec → invoke `writing-plans` for implementation plan → user approves plan → implement.

/**
 * HatchClient — Noise XX handshake over WebSocket + stream dispatch.
 * Ported from phase4/chat.py (commit 31bbda2), class HatchClient.
 *
 * ponytail: cycletls has no WS client API (it only does HTTP via Go subprocess).
 * We use Node 22's built-in WebSocket (globalThis.WebSocket) for the connection.
 * The `tls` param is accepted for API compatibility but unused at runtime.
 * See task-13-report.md for details.
 */

import { randomBytes } from "node:crypto";
import { XxInitiator } from "../noise/index.js";
import { CipherState } from "../noise/index.js";
import {
  buildApplicationRequest,
  buildServiceFrame,
  buildServiceRequest,
  parseServiceResponse,
  parseServiceFrame,
  parseNoiseTransportFrame,
} from "./envelope.js";
import { buildTransportFrames } from "./transport.js";
import { SHARED_HEADERS } from "./tls.js";
import { SERVICE_DAEMON } from "../proto/types.js";
import { logger } from "../log.js";
import type { Session } from "../bootstrap/session.js";

export type { Session };

// ponytail: cycletls CycleTLSClient — kept in signature for API compat; unused at runtime.
type CycleTLSClient = Awaited<ReturnType<typeof import("cycletls").default>>;

export type RecvEvent =
  | { kind: "event";    streamId: bigint; obj: Record<string, unknown> }
  | { kind: "complete"; streamId: bigint; status: number; body: unknown }
  | { kind: "reset";    streamId: bigint; code: number; reason: string };

// Internal per-stream body accumulator.
interface StreamBucket {
  status: number;
  body: Uint8Array[];
}

// ponytail: minimal WS shape — avoids DOM lib dependency (lib: ["ES2022"]).
// Covers exactly what HatchClient needs from Node 22's built-in WebSocket.
interface MinWs {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: "open",    listener: () => void): void;
  addEventListener(type: "close",   listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error",   listener: (ev: { message?: string }) => void): void;
  removeEventListener(type: "open",    listener: () => void): void;
  removeEventListener(type: "close",   listener: () => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "error",   listener: (ev: { message?: string }) => void): void;
}

// Node 22 exposes WebSocket on globalThis; cast through unknown to avoid DOM lib requirement.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, opts?: unknown) => MinWs }).WebSocket;

/** Normalise WS binary message data to Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer)  return new Uint8Array(data);
  if (ArrayBuffer.isView(data))     return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Buffer[] (unlikely for arraybuffer binaryType, but safe)
  if (Array.isArray(data)) {
    const total = (data as Uint8Array[]).reduce((n, b) => n + b.byteLength, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const b of data as Uint8Array[]) { out.set(b, off); off += b.byteLength; }
    return out;
  }
  throw new Error(`Unexpected WS binary data type: ${typeof data}`);
}

export class HatchClient {
  private readonly _ws:    MinWs;
  private readonly _send:  CipherState;
  private readonly _recv:  CipherState;
  private _streamId  = 0n;
  private _chunkId   = 0n;
  private _closed    = false;

  // Inbound chunk-reassembly: keyed by numeric chunk_id.
  private readonly _assemblies = new Map<
    number,
    { chunks: Map<number, Uint8Array>; total: number }
  >();

  // Per-stream body accumulator.
  private readonly _streamBodies = new Map<bigint, StreamBucket>();

  // Inbound message queue drained by recvOne.
  private readonly _msgQueue: Uint8Array[] = [];
  private _wsCloseFlag = false;

  private constructor(ws: MinWs, send: CipherState, recv: CipherState) {
    this._ws   = ws;
    this._send = send;
    this._recv = recv;

    ws.addEventListener("message", (ev) => {
      try { this._msgQueue.push(toBytes(ev.data)); } catch { /* skip malformed */ }
    });
    ws.addEventListener("close", () => { this._wsCloseFlag = true; });
    // ponytail: error events just set closed; callers will get null/closed from recvOne.
    ws.addEventListener("error", () => { this._wsCloseFlag = true; });
  }

  static async open(
    session: Session,
    // ponytail: unused — cycletls has no WS API; native Node WebSocket handles connection.
    _tls: CycleTLSClient,
  ): Promise<HatchClient> {
    const ws = await HatchClient._connect(session.ws_url);

    const hs = new XxInitiator();

    // msg1: e-pub (32 B) + encryptAndHash(payload). Payload = protobuf field-1 wrap of 32-byte nonce.
    const nonce   = randomBytes(32);
    const payload = Buffer.concat([Buffer.from([0x0a, 0x20]), nonce]);
    const msg1    = hs.writeMessage1(payload);
    ws.send(msg1);

    // msg2: receive + discard decrypted payload (we don't use the server's nonce).
    const msg2raw = await HatchClient._wsRecv(ws);
    hs.readMessage2(msg2raw);

    // msg3: enc_s + encryptAndHash(empty). Splits into (send, recv) CipherStates.
    const { bytes: msg3, split: { send, recv } } = hs.writeMessage3(new Uint8Array(0));
    ws.send(msg3);

    // Kick frame: AEAD tag for empty plaintext — prevents server idle-close.
    const kickCt = send.encrypt(new Uint8Array(), new Uint8Array());
    ws.send(kickCt);

    logger.debug({ url: session.ws_url }, "hatch: noise handshake complete");
    return new HatchClient(ws, send, recv);
  }

  /** Fire-and-forget. Returns bigint stream_id. */
  request(
    verb: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): bigint {
    if (this._closed) throw new Error("HatchClient is closed");

    this._streamId++;
    this._chunkId++;
    const sid = this._streamId;
    const cid = this._chunkId;

    // Serialize body.
    let bodyBytes: Uint8Array | undefined;
    if (body !== undefined) {
      bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    }

    // Header list: omit content-type if no body (mirrors Python behaviour).
    const hdrList: Array<[string, string]> = [];
    if (bodyBytes !== undefined && bodyBytes.length > 0) {
      hdrList.push(["content-type", "application/json"]);
    }
    hdrList.push(["accept-language", "en-US"]);
    if (headers) {
      for (const [k, v] of Object.entries(headers)) hdrList.push([k, v]);
    }

    const ar     = buildApplicationRequest(verb, path, bodyBytes, hdrList);
    const sf     = buildServiceFrame(sid, ar);
    const sr     = buildServiceRequest(SERVICE_DAEMON, sf);
    const frames = buildTransportFrames(cid, sr);

    for (const frame of frames) {
      const ct = this._send.encrypt(new Uint8Array(), frame);
      this._ws.send(ct);
    }

    logger.debug({ sid: String(sid), verb, path }, "hatch: request sent");
    return sid;
  }

  /**
   * Pull one fully-dispatched event or signal.
   * Returns null on timeout/incomplete assembly, "closed" on WS close.
   */
  async recvOne(timeoutMs = 1500): Promise<RecvEvent | null | "closed"> {
    const data = await this._dequeueWithTimeout(timeoutMs);
    if (data === null)     return null;
    if (data === "closed") return "closed";

    // Decrypt.
    let pt: Uint8Array;
    try {
      pt = this._recv.decrypt(new Uint8Array(), data);
    } catch {
      logger.debug("hatch: decrypt failed, skipping frame");
      return null;
    }

    // Parse NoiseTransportFrame.
    let tx: ReturnType<typeof parseNoiseTransportFrame>;
    try {
      tx = parseNoiseTransportFrame(pt);
    } catch {
      return null;
    }

    const chunkId    = Number(tx.chunk_id    ?? 0);
    const chunkIndex = Number(tx.chunk_index ?? 0);
    const total      = Number(tx.total_chunks ?? 1);
    const payload    = tx.payload ?? new Uint8Array();

    // Reassemble multi-chunk frames.
    let asm = this._assemblies.get(chunkId);
    if (!asm) {
      asm = { chunks: new Map(), total };
      this._assemblies.set(chunkId, asm);
      // ponytail: cap at 128 in-flight chunk assemblies, drop oldest half if exceeded.
      // Each incomplete assembly costs memory; a leak here was flagged in final review.
      if (this._assemblies.size > 128) {
        logger.warn({ size: this._assemblies.size }, "chunk-assembly map exceeded cap; clearing stale entries");
        const toDelete: number[] = [];
        let n = 0;
        for (const k of this._assemblies.keys()) {
          if (n++ >= this._assemblies.size / 2) break;
          toDelete.push(k);
        }
        for (const k of toDelete) this._assemblies.delete(k);
      }
    }
    asm.chunks.set(chunkIndex, payload);
    if (asm.chunks.size < asm.total) return null;

    // All chunks present — concatenate in index order.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < asm.total; i++) {
      // ponytail: fallback to empty — total verified above, so gap shouldn't occur.
      parts.push(asm.chunks.get(i) ?? new Uint8Array());
    }
    const full = HatchClient._concat(parts);
    this._assemblies.delete(chunkId);

    // Parse ServiceResponse → ServiceFrame.
    let sf: ReturnType<typeof parseServiceFrame>;
    try {
      const srParsed = parseServiceResponse(full);
      sf = parseServiceFrame(srParsed.payload ?? new Uint8Array());
    } catch {
      return null;
    }

    const streamId = BigInt(sf.stream_id ?? 0);

    // Dispatch on which oneof field is populated.
    if (sf.reset) {
      this._streamBodies.delete(streamId);
      return {
        kind:   "reset",
        streamId,
        code:   sf.reset.code   ?? 0,
        reason: sf.reset.reason ?? "",
      };
    }

    if (sf.response) {
      const r  = sf.response;
      let b    = this._streamBodies.get(streamId);
      if (!b) {
        b = { status: r.status ?? 0, body: [] };
        this._streamBodies.set(streamId, b);
      }
      if (r.status !== undefined) b.status = r.status;
      if (r.body && r.body.length > 0) b.body.push(r.body);
      if (r.end_body) {
        const raw  = HatchClient._concat(b.body);
        this._streamBodies.delete(streamId);
        const body = raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {};
        return { kind: "complete", streamId, status: b.status, body };
      }
      return null;
    }

    if (sf.body_chunk) {
      const bc = sf.body_chunk;
      let b    = this._streamBodies.get(streamId);
      if (!b) {
        b = { status: 0, body: [] };
        this._streamBodies.set(streamId, b);
      }

      if (bc.data && bc.data.length > 0) {
        // Try immediate JSON event dispatch (subscribe streams emit one object per chunk).
        try {
          const obj = JSON.parse(new TextDecoder().decode(bc.data)) as unknown;
          if (
            typeof obj === "object" && obj !== null &&
            !Array.isArray(obj) && "event" in obj
          ) {
            return { kind: "event", streamId, obj: obj as Record<string, unknown> };
          }
        } catch { /* not valid JSON or not an event — accumulate below */ }
        b.body.push(bc.data);
      }

      if (bc.end_body) {
        const raw  = HatchClient._concat(b.body);
        this._streamBodies.delete(streamId);
        const body = raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {};
        return { kind: "complete", streamId, status: b.status, body };
      }
      return null;
    }

    return null;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try { this._ws.close(); } catch { /* ignore */ }
  }

  // ---- internal helpers ----

  /** Concatenate Uint8Array parts without Buffer. */
  private static _concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, b) => n + b.byteLength, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  /** Open a Node 22 native WebSocket with Chrome-like headers. */
  private static _connect(url: string): Promise<MinWs> {
    return new Promise((resolve, reject) => {
      const ws = new NodeWebSocket(url, {
        headers: { ...SHARED_HEADERS },
      });
      ws.binaryType = "arraybuffer";

      const onOpen  = () => { cleanup(); resolve(ws); };
      const onError = (ev: { message?: string }) => {
        cleanup();
        reject(new Error(`WebSocket connect failed: ${ev.message ?? "unknown"}`));
      };
      const cleanup = () => {
        ws.removeEventListener("open",  onOpen);
        ws.removeEventListener("error", onError);
      };

      ws.addEventListener("open",  onOpen);
      ws.addEventListener("error", onError);
    });
  }

  /** Receive one binary WS frame during the handshake (before the message queue is attached). */
  private static _wsRecv(ws: MinWs): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const onMsg   = (ev: { data: unknown }) => { cleanup(); resolve(toBytes(ev.data)); };
      const onClose = () => { cleanup(); reject(new Error("WS closed during handshake")); };
      const onError = (ev: { message?: string }) => {
        cleanup();
        reject(new Error(`WS error during handshake: ${ev.message ?? ""}`));
      };
      const cleanup = () => {
        ws.removeEventListener("message", onMsg);
        ws.removeEventListener("close",   onClose);
        ws.removeEventListener("error",   onError);
      };
      ws.addEventListener("message", onMsg);
      ws.addEventListener("close",   onClose);
      ws.addEventListener("error",   onError);
    });
  }

  /**
   * Drain one item from _msgQueue with a timeout.
   * Returns null on timeout, "closed" if WS is closed and queue is empty.
   */
  private _dequeueWithTimeout(
    timeoutMs: number,
  ): Promise<Uint8Array | null | "closed"> {
    return new Promise((resolve) => {
      // Fast path: something already queued.
      if (this._msgQueue.length > 0) { resolve(this._msgQueue.shift()!); return; }
      if (this._wsCloseFlag)          { resolve("closed");                return; }

      const deadline = Date.now() + timeoutMs;

      const poll = (): void => {
        if (this._msgQueue.length > 0) { resolve(this._msgQueue.shift()!); return; }
        if (this._wsCloseFlag)          { resolve("closed");                return; }
        if (Date.now() >= deadline)     { resolve(null);                    return; }
        // ponytail: 4 ms poll — low overhead over typical 1500ms window.
        setTimeout(poll, 4);
      };
      poll();
    });
  }
}

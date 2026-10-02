import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTransportFrames, MAX_CHUNK_PAYLOAD } from "../src/hatch/transport.js";
import { parseNoiseTransportFrame } from "../src/hatch/envelope.js";

test("short payload yields one frame", () => {
  const parts = buildTransportFrames(42n, new Uint8Array([1, 2, 3, 4]));
  assert.equal(parts.length, 1);
  const f = parseNoiseTransportFrame(parts[0]!);
  assert.equal(Number(f.chunk_id), 42);
  assert.equal(f.chunk_index, 0);
  assert.equal(f.total_chunks, 1);
  assert.deepEqual(Array.from(f.payload!), [1, 2, 3, 4]);
});

test("100 KB payload chunks across ceil(100KB/48KB)=3 frames", () => {
  const payload = new Uint8Array(100 * 1024).fill(0x33);
  const parts = buildTransportFrames(7n, payload);
  assert.equal(parts.length, 3);
  const framed = parts.map(parseNoiseTransportFrame);
  assert.deepEqual(
    framed.map((f) => f.chunk_index),
    [0, 1, 2],
  );
  assert.deepEqual(
    framed.map((f) => f.total_chunks),
    [3, 3, 3],
  );
  const reassembled = Buffer.concat(framed.map((f) => Buffer.from(f.payload!)));
  assert.equal(reassembled.length, payload.length);
  assert.ok(reassembled.equals(Buffer.from(payload)));
});

test("exact 48KB payload yields one frame", () => {
  const parts = buildTransportFrames(1n, new Uint8Array(MAX_CHUNK_PAYLOAD));
  assert.equal(parts.length, 1);
});

test("48KB+1 payload yields two frames", () => {
  const parts = buildTransportFrames(
    1n,
    new Uint8Array(MAX_CHUNK_PAYLOAD + 1),
  );
  assert.equal(parts.length, 2);
});

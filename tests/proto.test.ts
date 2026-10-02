import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSchemas } from "../src/proto/loader.js";

test("loadSchemas resolves NoiseTransportFrame", () => {
  const root = loadSchemas();
  const T = root.lookupType("ingress_rev_proxy.NoiseTransportFrame");
  assert.ok(T);
  // proto field names are snake_case; create() accepts both snake and camelCase aliases
  const msg = T.create({ chunk_id: 1, chunk_index: 0, total_chunks: 1, payload: new Uint8Array([1, 2]) });
  const bytes = T.encode(msg).finish();
  // toObject with longs:Number converts Long→number; fields stay snake_case as per proto
  const decoded = T.toObject(T.decode(bytes), { longs: Number }) as unknown as { chunk_id: number; payload: Uint8Array };
  assert.equal(decoded.chunk_id, 1);
  assert.deepEqual(Array.from(decoded.payload), [1, 2]);
});

test("loadSchemas resolves ApplicationRequest", () => {
  const root = loadSchemas();
  const T = root.lookupType("hatch.noise.ApplicationRequest");
  // proto field names are snake_case (end_body, not endBody)
  const msg = T.create({ verb: "GET", path: "/x", end_body: true });
  const bytes = T.encode(msg).finish();
  const decoded = T.toObject(T.decode(bytes), { longs: Number }) as unknown as { verb: string; path: string; endBody: boolean };
  assert.equal(decoded.verb, "GET");
  assert.equal(decoded.path, "/x");
});

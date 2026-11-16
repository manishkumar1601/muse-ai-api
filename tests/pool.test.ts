import { test } from "node:test";
import assert from "node:assert/strict";
import { createClientPool } from "../src/hatch/pool.js";
import type { HatchClient } from "../src/hatch/client.js";

function fakeClient(id: number): { client: HatchClient; closed: boolean } {
  const state = { closed: false };
  const client = { id, close: async () => { state.closed = true; } } as unknown as HatchClient;
  return { client, get closed() { return state.closed; } };
}

test("pool opens exactly once and reuses the same client", async () => {
  let opens = 0;
  const made = fakeClient(1);
  const pool = createClientPool({ openClient: async () => { opens++; return made.client; } });
  const a = await pool.withClient(async (c) => c);
  const b = await pool.withClient(async (c) => c);
  assert.equal(opens, 1);
  assert.strictEqual(a, b);
  assert.strictEqual(a, made.client);
});

test("pool allows concurrent callers (multiplex) sharing one client", async () => {
  const made = fakeClient(1);
  const pool = createClientPool({ openClient: async () => made.client });
  let inFlight = 0;
  let maxInFlight = 0;
  const seenClients: Array<unknown> = [];
  const run = async () => pool.withClient(async (c) => {
    seenClients.push(c);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  });
  await Promise.all([run(), run(), run()]);
  assert.ok(maxInFlight >= 2, `expected concurrent overlap, got max ${maxInFlight}`);
  assert.equal(new Set(seenClients).size, 1);
});

test("pool opens exactly once under concurrent first-call race", async () => {
  let opens = 0;
  const made = fakeClient(1);
  const pool = createClientPool({ openClient: async () => {
    opens++;
    await new Promise((r) => setTimeout(r, 10));
    return made.client;
  } });
  await Promise.all([
    pool.withClient(async () => { /* a */ }),
    pool.withClient(async () => { /* b */ }),
    pool.withClient(async () => { /* c */ }),
  ]);
  assert.equal(opens, 1);
});

test("pool resets on error: closes broken client + reopens for next caller", async () => {
  const c1 = fakeClient(1);
  const c2 = fakeClient(2);
  const queue = [c1.client, c2.client];
  const pool = createClientPool({ openClient: async () => queue.shift()! });
  await assert.rejects(pool.withClient(async () => { throw new Error("boom"); }));
  assert.equal(c1.closed, true);
  const after = await pool.withClient(async (c) => c);
  assert.strictEqual(after, c2.client);
});

test("pool reset() closes current client and forces reopen", async () => {
  const c1 = fakeClient(1);
  const c2 = fakeClient(2);
  const queue = [c1.client, c2.client];
  const pool = createClientPool({ openClient: async () => queue.shift()! });
  await pool.withClient(async () => { /* warm */ });
  await pool.reset();
  assert.equal(c1.closed, true);
  const after = await pool.withClient(async (c) => c);
  assert.strictEqual(after, c2.client);
});

test("pool peek() returns current or null", async () => {
  const c1 = fakeClient(1);
  const pool = createClientPool({ openClient: async () => c1.client });
  assert.equal(pool.peek(), null);
  await pool.withClient(async () => { /* warm */ });
  assert.strictEqual(pool.peek(), c1.client);
  await pool.reset();
  assert.equal(pool.peek(), null);
});

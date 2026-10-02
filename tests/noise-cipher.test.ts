import { test } from "node:test";
import assert from "node:assert/strict";
import { CipherState, noiseNonce } from "../src/noise/cipher.js";

test("noiseNonce layout is 4 zero bytes + big-endian u64", () => {
  assert.deepEqual(noiseNonce(0n), new Uint8Array([0,0,0,0, 0,0,0,0,0,0,0,0]));
  assert.deepEqual(noiseNonce(1n), new Uint8Array([0,0,0,0, 0,0,0,0,0,0,0,1]));
  assert.deepEqual(noiseNonce(258n), new Uint8Array([0,0,0,0, 0,0,0,0,0,0,1,2]));
});

test("round-trip encrypt/decrypt", () => {
  const key = new Uint8Array(32); key.fill(7);
  const enc = new CipherState(key);
  const dec = new CipherState(key);
  const ct = enc.encrypt(new Uint8Array(), new TextEncoder().encode("hello"));
  const pt = dec.decrypt(new Uint8Array(), ct);
  assert.deepEqual(new TextDecoder().decode(pt), "hello");
  assert.equal(enc.nonce, 1n);
  assert.equal(dec.nonce, 1n);
});

test("decrypt with wrong key throws", () => {
  const enc = new CipherState(new Uint8Array(32).fill(1));
  const dec = new CipherState(new Uint8Array(32).fill(2));
  const ct = enc.encrypt(new Uint8Array(), new Uint8Array([1,2,3]));
  assert.throws(() => dec.decrypt(new Uint8Array(), ct));
});

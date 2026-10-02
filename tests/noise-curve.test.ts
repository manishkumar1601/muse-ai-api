import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, dh } from "../src/noise/curve.js";

test("ECDH is symmetric", () => {
  const a = generateKeyPair(), b = generateKeyPair();
  const s1 = dh(a.priv, b.pub);
  const s2 = dh(b.priv, a.pub);
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 32);
});

test("pub is 32 bytes", () => {
  const k = generateKeyPair();
  assert.equal(k.pub.length, 32);
  assert.equal(k.priv.length, 32);
});

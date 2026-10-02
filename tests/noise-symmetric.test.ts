import { test } from "node:test";
import assert from "node:assert/strict";
import { SymmetricState } from "../src/noise/symmetric.js";

test("mixHash with suite name initializes h", () => {
  const s = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  assert.equal(s.h.length, 32);
});

test("encryptAndHash is a no-op before mixKey (no cipher)", () => {
  const s = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  const pt = new Uint8Array([1, 2, 3]);
  const out = s.encryptAndHash(pt);
  assert.deepEqual(out, pt);
});

test("encryptAndHash + decryptAndHash round-trip after mixKey", () => {
  const a = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  const b = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  const ikm = new Uint8Array(32).fill(9);
  a.mixKey(ikm);
  b.mixKey(ikm);
  const ct = a.encryptAndHash(new TextEncoder().encode("hi"));
  const pt = b.decryptAndHash(ct);
  assert.deepEqual(new TextDecoder().decode(pt), "hi");
});

test("split returns two cipherstates with distinct keys", () => {
  const s = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  s.mixKey(new Uint8Array(32).fill(3));
  const { c1, c2 } = s.split();
  const ct1 = c1.encrypt(new Uint8Array(), new Uint8Array([1]));
  const ct2 = c2.encrypt(new Uint8Array(), new Uint8Array([1]));
  assert.notDeepEqual(ct1, ct2);
});

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { XxInitiator } from "../src/noise/handshake.js";
import { SymmetricState } from "../src/noise/symmetric.js";
import { generateKeyPair, dh } from "../src/noise/curve.js";

describe("XxInitiator.writeMessage1", () => {
  it("32-byte payload → 64 bytes; bytes 32..64 == payload (no cipher yet)", () => {
    const init = new XxInitiator();
    const payload = new Uint8Array(32).fill(0xab);
    const msg = init.writeMessage1(payload);
    assert.equal(msg.length, 64);
    // Before any DH, encryptAndHash is a no-op on the cipher — just mixHash; plaintext passes through
    assert.deepEqual(msg.slice(32, 64), payload);
  });

  it("34-byte payload (0x0a 0x20 + 32 bytes) → 66 bytes", () => {
    const init = new XxInitiator();
    const payload = new Uint8Array(34);
    payload[0] = 0x0a;
    payload[1] = 0x20;
    payload.fill(0xcd, 2);
    const msg = init.writeMessage1(payload);
    assert.equal(msg.length, 66);
  });
});

test("XX full round-trip against stub responder", () => {
  const initStatic = generateKeyPair();
  const respStatic = generateKeyPair();
  const init = new XxInitiator(new Uint8Array(), initStatic);

  // responder mirrors initiator's SymmetricState
  const rss = new SymmetricState("Noise_XX_25519_AESGCM_SHA256");
  rss.mixHash(new Uint8Array());

  // --- msg1 ---
  const msg1 = init.writeMessage1(new Uint8Array());
  const re_at_resp = msg1.slice(0, 32);
  rss.mixHash(re_at_resp);
  const msg1_payload = rss.decryptAndHash(msg1.slice(32)); // no-op pre-cipher
  assert.equal(msg1_payload.length, 0);

  // --- msg2: responder sends e || enc_s || enc_payload ---
  const respE = generateKeyPair();
  rss.mixHash(respE.pub);
  rss.mixKey(dh(respE.priv, re_at_resp)); // ee
  const enc_s = rss.encryptAndHash(respStatic.pub);
  rss.mixKey(dh(respStatic.priv, re_at_resp)); // es
  const enc_payload2 = rss.encryptAndHash(new Uint8Array());
  const msg2 = new Uint8Array(respE.pub.length + enc_s.length + enc_payload2.length);
  msg2.set(respE.pub, 0);
  msg2.set(enc_s, 32);
  msg2.set(enc_payload2, 32 + enc_s.length);

  // initiator reads msg2
  const msg2_payload = init.readMessage2(msg2);
  assert.equal(msg2_payload.length, 0);

  // --- msg3: initiator sends enc_s || enc_payload ---
  const res = init.writeMessage3(new Uint8Array());

  // responder reads msg3
  const resp_rs = rss.decryptAndHash(res.bytes.slice(0, 48));
  rss.mixKey(dh(respE.priv, resp_rs)); // se
  const msg3_payload = rss.decryptAndHash(res.bytes.slice(48));
  assert.equal(msg3_payload.length, 0);

  // msg3 layout: 48 (enc_s) + 16 (enc empty payload MAC) = 64
  assert.equal(res.bytes.length, 64);

  // split: initiator c1=send, responder c1=recv (symmetric — same ck at split time)
  const respSplit = rss.split();
  const probe = new TextEncoder().encode("ping");
  const ctFromInitSend = res.split.send.encrypt(new Uint8Array(), probe);
  const ptAtRespRecv = respSplit.c1.decrypt(new Uint8Array(), ctFromInitSend);
  assert.equal(new TextDecoder().decode(ptAtRespRecv), "ping");

  // handshakeHash on both sides must match
  assert.deepEqual(res.handshakeHash, rss.h);

  // remoteStatic returned by initiator must equal responder's static pub
  assert.deepEqual(res.remoteStatic, respStatic.pub);
});

test("XxInitiator phase guard — readMessage2 before writeMessage1 throws", () => {
  const hs = new XxInitiator();
  assert.throws(() => hs.readMessage2(new Uint8Array(96)), /phase/);
});

test("XxInitiator phase guard — writeMessage3 before readMessage2 throws", () => {
  const hs = new XxInitiator();
  hs.writeMessage1(new Uint8Array());
  assert.throws(() => hs.writeMessage3(new Uint8Array()), /phase/);
});

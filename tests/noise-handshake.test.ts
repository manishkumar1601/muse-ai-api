import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { XxInitiator } from "../src/noise/handshake.js";

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

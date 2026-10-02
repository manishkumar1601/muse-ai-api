import { SymmetricState } from "./symmetric.js";
import { type KeyPair, generateKeyPair, dh } from "./curve.js";
import { type CipherState } from "./cipher.js";

const PROTOCOL = "Noise_XX_25519_AESGCM_SHA256";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

export class XxInitiator {
  private readonly ss: SymmetricState;
  private readonly s: KeyPair;
  private e: KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private phase = 1;

  constructor(prologue: Uint8Array = new Uint8Array(), staticKey?: KeyPair) {
    this.ss = new SymmetricState(PROTOCOL);
    this.ss.mixHash(prologue);
    this.s = staticKey ?? generateKeyPair();
  }

  writeMessage1(payload: Uint8Array): Uint8Array {
    if (this.phase !== 1) throw new Error("writeMessage1 called in wrong phase");
    this.e = generateKeyPair();
    this.ss.mixHash(this.e.pub);
    const encPayload = this.ss.encryptAndHash(payload);
    this.phase = 2;
    return concat(this.e.pub, encPayload);
  }

  readMessage2(msg: Uint8Array): Uint8Array {
    if (this.phase !== 2) throw new Error("readMessage2 called in wrong phase");
    if (msg.length < 96) throw new Error(`message2 too short: ${msg.length} < 96`);
    if (this.e === null) throw new Error("ephemeral key missing");

    const re = msg.slice(0, 32);
    this.re = re;
    this.ss.mixHash(re);
    this.ss.mixKey(dh(this.e.priv, re));                  // ee
    const rs = this.ss.decryptAndHash(msg.slice(32, 80)); // enc_s: 48 bytes → 32 plaintext
    this.rs = rs;
    this.ss.mixKey(dh(this.e.priv, rs));                  // es
    const payload = this.ss.decryptAndHash(msg.slice(80));
    this.phase = 3;
    return payload;
  }

  writeMessage3(payload: Uint8Array): {
    bytes: Uint8Array;
    split: { send: CipherState; recv: CipherState };
    remoteStatic: Uint8Array;
    handshakeHash: Uint8Array;
  } {
    if (this.phase !== 3) throw new Error("writeMessage3 called in wrong phase");
    if (this.re === null || this.rs === null) throw new Error("handshake state incomplete");

    const encS = this.ss.encryptAndHash(this.s.pub);      // 48 bytes
    this.ss.mixKey(dh(this.s.priv, this.re));              // se
    const encPayload = this.ss.encryptAndHash(payload);
    const { c1, c2 } = this.ss.split();
    this.phase = 4;

    return {
      bytes: concat(encS, encPayload),
      split: { send: c1, recv: c2 },
      remoteStatic: this.rs,
      handshakeHash: this.ss.h.slice(), // ponytail: snapshot — ss.h mutates after split in some impls
    };
  }
}

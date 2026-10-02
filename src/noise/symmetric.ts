import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { CipherState } from "./cipher.js";
import { concat } from "./util.js";

function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)));
  return [o1, o2];
}

export class SymmetricState {
  h: Uint8Array;
  ck: Uint8Array;
  cipher: CipherState | null = null;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= 32) {
      this.h = new Uint8Array(32);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h.slice();
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  encryptAndHash(pt: Uint8Array): Uint8Array {
    const out = this.cipher ? this.cipher.encrypt(this.h, pt) : pt;
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cipher ? this.cipher.decrypt(this.h, ct) : ct;
    this.mixHash(ct);
    return pt;
  }

  split(): { c1: CipherState; c2: CipherState } {
    const [k1, k2] = hkdf(this.ck, new Uint8Array());
    return { c1: new CipherState(k1), c2: new CipherState(k2) };
  }
}

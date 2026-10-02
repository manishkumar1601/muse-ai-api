import { gcm } from "@noble/ciphers/aes";

export function noiseNonce(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(4, Number(n >> 32n) & 0xffffffff, false);
  view.setUint32(8, Number(n & 0xffffffffn), false);
  return out;
}

export class CipherState {
  nonce = 0n;
  constructor(private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error(`CipherState key must be 32 bytes, got ${key.length}`);
  }
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    const ct = gcm(this.key, noiseNonce(this.nonce), ad).encrypt(pt);
    this.nonce++;
    return ct;
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    const pt = gcm(this.key, noiseNonce(this.nonce), ad).decrypt(ct);
    this.nonce++;
    return pt;
  }
}

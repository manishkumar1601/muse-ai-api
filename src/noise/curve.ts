import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "@noble/hashes/utils";

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const priv = randomBytes(32);
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

export function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub);
}

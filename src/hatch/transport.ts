import { loadSchemas } from "../proto/loader.js";
import type { NoiseTransportFrame } from "../proto/types.js";

const T = loadSchemas().lookupType("ingress_rev_proxy.NoiseTransportFrame");

export const MAX_CHUNK_PAYLOAD = 48 * 1024;

export function buildTransportFrames(
  chunk_id: bigint,
  serviceRequestBytes: Uint8Array,
): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const len = serviceRequestBytes.length;
  const total = len === 0 ? 1 : Math.ceil(len / MAX_CHUNK_PAYLOAD);
  for (let i = 0; i < total; i++) {
    const slice = serviceRequestBytes.slice(
      i * MAX_CHUNK_PAYLOAD,
      (i + 1) * MAX_CHUNK_PAYLOAD,
    );
    const msg: NoiseTransportFrame = {
      chunk_id: Number(chunk_id),
      chunk_index: i,
      total_chunks: total,
      payload: slice,
    };
    parts.push(T.encode(T.create(msg)).finish());
  }
  return parts;
}

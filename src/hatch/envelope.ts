import { loadSchemas } from "../proto/loader.js";
import type { NoiseTransportFrame, ServiceFrame, ServiceResponse } from "../proto/types.js";

const root  = loadSchemas();
const T_AR  = root.lookupType("hatch.noise.ApplicationRequest");
const T_SF  = root.lookupType("hatch.noise.ServiceFrame");
const T_SRQ = root.lookupType("hatch.noise.ServiceRequest");
const T_SRS = root.lookupType("hatch.noise.ServiceResponse");
const T_NTF = root.lookupType("ingress_rev_proxy.NoiseTransportFrame");

export function buildApplicationRequest(
  verb: string,
  path: string,
  body?: Uint8Array,
  headers?: Array<[string, string]>,
): Uint8Array {
  const msg = T_AR.create({
    verb,
    path,
    headers: (headers ?? []).map(([key, value]) => ({ key, value })),
    body: body ?? new Uint8Array(),
    end_body: true,
  });
  return T_AR.encode(msg).finish();
}

export function buildServiceFrame(stream_id: bigint, requestBytes: Uint8Array): Uint8Array {
  // ponytail: decode→re-embed so protobufjs treats it as nested message, not raw bytes.
  // protobufjs Long does not accept native bigint — Number() is safe for stream IDs
  // that fit in 53-bit range (session lifetime well under 2^53).
  const request = T_AR.decode(requestBytes);
  return T_SF.encode(T_SF.create({ stream_id: Number(stream_id), request })).finish();
}

export function buildServiceRequest(service: number, serviceFrameBytes: Uint8Array): Uint8Array {
  return T_SRQ.encode(T_SRQ.create({ service, payload: serviceFrameBytes })).finish();
}

// ponytail: toObject with longs:Number converts Long→JS number so callers get plain values.
// Fails only for stream_ids > 2^53 — not a concern for session lifetimes.
export function parseServiceResponse(bytes: Uint8Array): ServiceResponse {
  return T_SRS.toObject(T_SRS.decode(bytes), { longs: Number }) as unknown as ServiceResponse;
}

export function parseServiceFrame(bytes: Uint8Array): ServiceFrame {
  return T_SF.toObject(T_SF.decode(bytes), { longs: Number }) as unknown as ServiceFrame;
}

export function parseNoiseTransportFrame(bytes: Uint8Array): NoiseTransportFrame {
  return T_NTF.toObject(T_NTF.decode(bytes), { longs: Number }) as unknown as NoiseTransportFrame;
}

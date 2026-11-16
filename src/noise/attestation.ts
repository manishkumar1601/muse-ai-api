import { loadSchemas } from "../proto/loader.js";

// AMD SEV-SNP ATTESTATION_REPORT binary layout (AMD "SEV Secure Nested Paging
// Firmware ABI Specification", table 22). Field offsets are stable across
// ABI versions; later versions add fields at the tail inside the reserved blocks.
// The report body is 672 bytes (0x000–0x29F); the signature is 512 bytes
// (ECDSA-P384 r || s, each 72 bytes padded to 256 bytes).
export const SNP_REPORT_BODY_LEN = 0x2A0;
export const SNP_REPORT_SIG_LEN  = 0x200;
export const SNP_REPORT_TOTAL_LEN = SNP_REPORT_BODY_LEN + SNP_REPORT_SIG_LEN;

export interface SnpReport {
  version: number;
  guest_svn: number;
  policy: bigint;
  family_id: Uint8Array;
  image_id: Uint8Array;
  vmpl: number;
  signature_algo: number;
  platform_version: bigint;
  platform_info: bigint;
  flags: number;
  report_data: Uint8Array;
  measurement: Uint8Array;
  host_data: Uint8Array;
  id_key_digest: Uint8Array;
  author_key_digest: Uint8Array;
  report_id: Uint8Array;
  report_id_ma: Uint8Array;
  reported_tcb: bigint;
  chip_id: Uint8Array;
  committed_tcb: bigint;
  current_version: { build: number; minor: number; major: number };
  committed_version: { build: number; minor: number; major: number };
  launch_tcb: bigint;
  signature: { r: Uint8Array; s: Uint8Array };
}

export function parseSnpReport(buf: Uint8Array): SnpReport {
  if (buf.length < SNP_REPORT_TOTAL_LEN) {
    throw new Error(`SNP report too short: ${buf.length} < ${SNP_REPORT_TOTAL_LEN}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o: number): number => dv.getUint32(o, true);
  const u64 = (o: number): bigint => dv.getBigUint64(o, true);
  const slice = (o: number, n: number): Uint8Array => buf.slice(o, o + n);

  // ECDSA-P384 sig: AMD stores r and s each as little-endian, padded to 72
  // bytes within a 256-byte slot. The remaining 112 bytes per slot are zero.
  const sigBase = SNP_REPORT_BODY_LEN;
  const r = slice(sigBase + 0,   72);
  const s = slice(sigBase + 256, 72);

  return {
    version: u32(0x000),
    guest_svn: u32(0x004),
    policy: u64(0x008),
    family_id: slice(0x010, 16),
    image_id:  slice(0x020, 16),
    vmpl: u32(0x030),
    signature_algo: u32(0x034),
    platform_version: u64(0x038),
    platform_info: u64(0x040),
    flags: u32(0x048),
    report_data: slice(0x050, 64),
    measurement: slice(0x090, 48),
    host_data:   slice(0x0C0, 32),
    id_key_digest:     slice(0x0E0, 48),
    author_key_digest: slice(0x110, 48),
    report_id:    slice(0x140, 32),
    report_id_ma: slice(0x160, 32),
    reported_tcb: u64(0x180),
    chip_id: slice(0x1A0, 64),
    committed_tcb: u64(0x1E0),
    current_version: { build: buf[0x1E8]!, minor: buf[0x1E9]!, major: buf[0x1EA]! },
    committed_version: { build: buf[0x1EC]!, minor: buf[0x1ED]!, major: buf[0x1EE]! },
    launch_tcb: u64(0x1F0),
    signature: { r, s },
  };
}

export interface ParsedBundle {
  platform: number;
  report_data_input?: Uint8Array;
  snp?: {
    report: Uint8Array;
    certs?: { vcek_pem?: Uint8Array; ask_pem?: Uint8Array; crl?: Uint8Array };
  };
  image_manifest?: Uint8Array;
  // Keep the raw proto decode available for callers that want other oneof branches.
  raw: Record<string, unknown>;
}

export interface ReportDataInput {
  x25519_public_key: Uint8Array;
  client_nonce: Uint8Array;
}

export function parseReportDataInput(bytes: Uint8Array): ReportDataInput {
  const root = loadSchemas();
  const T = root.lookupType("thatch.attestation.v1.ReportDataInput");
  const msg = T.decode(bytes);
  const obj = T.toObject(msg, { bytes: Uint8Array }) as { x25519_public_key?: Uint8Array; client_nonce?: Uint8Array };
  return {
    x25519_public_key: obj.x25519_public_key ?? new Uint8Array(),
    client_nonce: obj.client_nonce ?? new Uint8Array(),
  };
}

export function parseAttestationBundle(bytes: Uint8Array): ParsedBundle {
  const root = loadSchemas();
  const Bundle = root.lookupType("thatch.attestation.v1.AttestationBundle");
  const msg = Bundle.decode(bytes);
  const obj = Bundle.toObject(msg, { bytes: Uint8Array, longs: Number, enums: Number }) as Record<string, unknown>;
  const snp = obj["snp"] as { report?: Uint8Array; certs?: { vcek_pem?: Uint8Array; ask_pem?: Uint8Array; crl?: Uint8Array } } | undefined;
  return {
    platform: (obj["platform"] as number) ?? 0,
    ...(obj["report_data_input"] !== undefined ? { report_data_input: obj["report_data_input"] as Uint8Array } : {}),
    ...(snp && snp.report ? { snp: { report: snp.report, ...(snp.certs ? { certs: snp.certs } : {}) } } : {}),
    ...(obj["image_manifest"] !== undefined ? { image_manifest: obj["image_manifest"] as Uint8Array } : {}),
    raw: obj,
  };
}

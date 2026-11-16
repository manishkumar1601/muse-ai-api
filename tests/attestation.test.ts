import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnpReport, SNP_REPORT_BODY_LEN, SNP_REPORT_TOTAL_LEN } from "../src/noise/attestation.js";

function mkSyntheticReport(): Uint8Array {
  const buf = new Uint8Array(SNP_REPORT_TOTAL_LEN);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0x000, 2, true);                       // version = 2
  dv.setUint32(0x004, 1, true);                       // guest_svn = 1
  dv.setBigUint64(0x008, 0x30000ff00n, true);          // policy
  buf.set(new Uint8Array(16).fill(0xaa), 0x010);       // family_id
  buf.set(new Uint8Array(16).fill(0xbb), 0x020);       // image_id
  dv.setUint32(0x030, 0, true);                       // vmpl
  dv.setUint32(0x034, 1, true);                       // signature_algo = ECDSA_P384_SHA384
  dv.setBigUint64(0x038, 0x1200000000000055n, true);  // platform_version
  dv.setBigUint64(0x040, 0x0n, true);                 // platform_info
  dv.setUint32(0x048, 0, true);                       // flags
  const reportData = new Uint8Array(64);
  reportData[0] = 0xDE; reportData[1] = 0xAD; reportData[2] = 0xBE; reportData[3] = 0xEF;
  buf.set(reportData, 0x050);
  buf.set(new Uint8Array(48).fill(0x11), 0x090);       // measurement
  buf.set(new Uint8Array(32).fill(0x22), 0x0C0);       // host_data
  buf.set(new Uint8Array(48).fill(0x33), 0x0E0);       // id_key_digest
  buf.set(new Uint8Array(48).fill(0x44), 0x110);       // author_key_digest
  buf.set(new Uint8Array(32).fill(0x55), 0x140);       // report_id
  buf.set(new Uint8Array(32).fill(0x66), 0x160);       // report_id_ma
  dv.setBigUint64(0x180, 0xABCDn, true);               // reported_tcb
  buf.set(new Uint8Array(64).fill(0x77), 0x1A0);       // chip_id
  dv.setBigUint64(0x1E0, 0xDCBAn, true);               // committed_tcb
  buf[0x1E8] = 5;                                      // current_build
  buf[0x1E9] = 4;                                      // current_minor
  buf[0x1EA] = 3;                                      // current_major
  buf[0x1EC] = 2;                                      // committed_build
  buf[0x1ED] = 1;                                      // committed_minor
  buf[0x1EE] = 1;                                      // committed_major
  dv.setBigUint64(0x1F0, 0xEEEEn, true);               // launch_tcb
  // signature r + s in little-endian 72-byte slots inside 256-byte halves
  const r = new Uint8Array(72); r[0] = 0xAA; r[71] = 0x01;
  const s = new Uint8Array(72); s[0] = 0xBB; s[71] = 0x02;
  buf.set(r, SNP_REPORT_BODY_LEN + 0);
  buf.set(s, SNP_REPORT_BODY_LEN + 256);
  return buf;
}

test("parseSnpReport extracts fields at the correct AMD-spec offsets", () => {
  const buf = mkSyntheticReport();
  const r = parseSnpReport(buf);
  assert.equal(r.version, 2);
  assert.equal(r.guest_svn, 1);
  assert.equal(r.policy, 0x30000ff00n);
  assert.equal(r.family_id.every((b) => b === 0xaa), true);
  assert.equal(r.image_id.every((b) => b === 0xbb), true);
  assert.equal(r.vmpl, 0);
  assert.equal(r.signature_algo, 1);
  assert.equal(r.platform_version, 0x1200000000000055n);
  assert.equal(r.report_data.length, 64);
  assert.equal(r.report_data[0], 0xDE);
  assert.equal(r.report_data[3], 0xEF);
  assert.equal(r.measurement.length, 48);
  assert.equal(r.measurement.every((b) => b === 0x11), true);
  assert.equal(r.host_data.every((b) => b === 0x22), true);
  assert.equal(r.id_key_digest.every((b) => b === 0x33), true);
  assert.equal(r.author_key_digest.every((b) => b === 0x44), true);
  assert.equal(r.report_id.every((b) => b === 0x55), true);
  assert.equal(r.report_id_ma.every((b) => b === 0x66), true);
  assert.equal(r.reported_tcb, 0xABCDn);
  assert.equal(r.chip_id.every((b) => b === 0x77), true);
  assert.equal(r.committed_tcb, 0xDCBAn);
  assert.deepEqual(r.current_version, { major: 3, minor: 4, build: 5 });
  assert.deepEqual(r.committed_version, { major: 1, minor: 1, build: 2 });
  assert.equal(r.launch_tcb, 0xEEEEn);
  assert.equal(r.signature.r.length, 72);
  assert.equal(r.signature.s.length, 72);
  assert.equal(r.signature.r[0], 0xAA);
  assert.equal(r.signature.s[0], 0xBB);
});

test("parseSnpReport rejects truncated input", () => {
  assert.throws(() => parseSnpReport(new Uint8Array(100)));
});

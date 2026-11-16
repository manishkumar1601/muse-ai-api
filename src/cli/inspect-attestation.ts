import { readFileSync } from "node:fs";
import { parseAttestationBundle, parseReportDataInput, parseSnpReport } from "../noise/attestation.js";

const path = process.argv[2] ?? "attestation-dump.json";
const dump = JSON.parse(readFileSync(path, "utf-8")) as { msg2_payload_b64: string; msg1_nonce_b64: string; msg1_raw_b64: string; msg2_raw_b64: string; server_static_pub_b64?: string };

const bundleBytes = Buffer.from(dump.msg2_payload_b64, "base64");
console.log(`Bundle wire size: ${bundleBytes.length} bytes`);

const parsed = parseAttestationBundle(new Uint8Array(bundleBytes));
console.log(`Platform: ${parsed.platform} (1 = AMD_SEV_SNP)`);
console.log(`report_data_input: ${parsed.report_data_input ? parsed.report_data_input.length + " bytes" : "(absent)"}`);
console.log(`image_manifest:    ${parsed.image_manifest ? parsed.image_manifest.length + " bytes" : "(absent)"}`);

const msg1 = Buffer.from(dump.msg1_raw_b64, "base64");
const ourEphemeralPub = msg1.subarray(0, 32);
const ourNonce = Buffer.from(dump.msg1_nonce_b64, "base64");

if (parsed.report_data_input) {
  console.log("");
  console.log("--- ReportDataInput ---");
  const rdi = parseReportDataInput(parsed.report_data_input);
  const rpub = Buffer.from(rdi.x25519_public_key).toString("hex");
  const rnonce = Buffer.from(rdi.client_nonce).toString("hex");
  const msg2 = Buffer.from(dump.msg2_raw_b64, "base64");
  const serverEphemeral = msg2.subarray(0, 32).toString("hex");
  const serverStatic = dump.server_static_pub_b64
    ? Buffer.from(dump.server_static_pub_b64, "base64").toString("hex")
    : null;
  console.log(`  server-echoed x25519_pub:   ${rpub}`);
  console.log(`  server-echoed client_nonce: ${rnonce}`);
  console.log(`  our x25519 ephemeral pub:   ${ourEphemeralPub.toString("hex")}`);
  console.log(`  server x25519 ephemeral:    ${serverEphemeral}`);
  if (serverStatic) console.log(`  server x25519 static:       ${serverStatic}`);
  console.log(`  echoed_pub == our pub?        ${rpub === ourEphemeralPub.toString("hex")}`);
  console.log(`  echoed_pub == server ephem?   ${rpub === serverEphemeral}`);
  if (serverStatic) console.log(`  echoed_pub == server static?  ${rpub === serverStatic}`);
  console.log(`  echoed_nonce == our nonce?    ${rnonce === ourNonce.toString("hex")}`);
}

if (!parsed.snp) {
  console.log("");
  console.log("No SNP evidence — muse is running NON_TEE for this session.");
  console.log("The server-static key has no hardware attestation backing it.");
  console.log("MITM protection reduces to TLS trust in hatch.metaaivm.com.");
  process.exit(0);
}

console.log(`SNP report:        ${parsed.snp.report.length} bytes (expect 1184)`);
if (parsed.snp.certs) {
  console.log(`VCEK PEM:          ${parsed.snp.certs.vcek_pem?.length ?? 0} bytes`);
  console.log(`ASK PEM:           ${parsed.snp.certs.ask_pem?.length ?? 0} bytes`);
  console.log(`CRL:               ${parsed.snp.certs.crl?.length ?? 0} bytes`);
}

const r = parseSnpReport(parsed.snp.report);
const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");

console.log("");
console.log("--- SNP report (parsed) ---");
console.log(`version:           ${r.version}`);
console.log(`guest_svn:         ${r.guest_svn}`);
console.log(`policy:            0x${r.policy.toString(16)}`);
console.log(`family_id:         ${hex(r.family_id)}`);
console.log(`image_id:          ${hex(r.image_id)}`);
console.log(`vmpl:              ${r.vmpl}`);
console.log(`signature_algo:    ${r.signature_algo} (1 = ECDSA_P384_SHA384)`);
console.log(`platform_version:  0x${r.platform_version.toString(16)}`);
console.log(`platform_info:     0x${r.platform_info.toString(16)}`);
console.log(`flags:             0x${r.flags.toString(16)}`);
console.log(`report_data (64):  ${hex(r.report_data)}`);
console.log(`measurement (48):  ${hex(r.measurement)}`);
console.log(`host_data (32):    ${hex(r.host_data)}`);
console.log(`id_key_digest:     ${hex(r.id_key_digest)}`);
console.log(`author_key_digest: ${hex(r.author_key_digest)}`);
console.log(`report_id:         ${hex(r.report_id)}`);
console.log(`report_id_ma:      ${hex(r.report_id_ma)}`);
console.log(`reported_tcb:      0x${r.reported_tcb.toString(16)}`);
console.log(`chip_id (64):      ${hex(r.chip_id)}`);
console.log(`committed_tcb:     0x${r.committed_tcb.toString(16)}`);
console.log(`current_version:   ${r.current_version.major}.${r.current_version.minor}.${r.current_version.build}`);
console.log(`committed_version: ${r.committed_version.major}.${r.committed_version.minor}.${r.committed_version.build}`);
console.log(`launch_tcb:        0x${r.launch_tcb.toString(16)}`);
console.log(`signature r (72):  ${hex(r.signature.r)}`);
console.log(`signature s (72):  ${hex(r.signature.s)}`);

// Freshness check: does report_data embed our client state?
console.log("");
console.log("--- Freshness probe ---");
console.log(`our x25519 ephemeral pub: ${ourEphemeralPub.toString("hex")}`);
console.log(`our client_nonce:         ${ourNonce.toString("hex")}`);
const rd = Buffer.from(r.report_data);
console.log(`report_data contains our pub?   ${rd.includes(ourEphemeralPub)}`);
console.log(`report_data contains our nonce? ${rd.includes(ourNonce)}`);

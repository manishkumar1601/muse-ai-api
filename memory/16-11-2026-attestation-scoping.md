# Attestation verification — scoping notes (16-11-2026)

## Goal

Scope what "Phase 8 attestation chain verification" actually entails. The
existing docs call it "ed25519 chain verification" which turns out to be
wrong — the real target is AMD SEV-SNP, significantly bigger.

## What `attestation_bundle.proto.binpb` actually contains

Walked the FileDescriptorProto. Relevant messages:

- `thatch.attestation.v1.Platform` enum: `NON_TEE = 0`, `AMD_SEV_SNP = 1`.
- `thatch.attestation.v1.AttestationBundle`:
  - `platform`
  - `report_data_input` (bytes — binds the attestation to our client state)
  - `snp: SnpEvidence` (oneof, only member present today)
  - `image_manifest` (bytes — hashes of the VM's loaded image)
  - `transparency_proof` (sigstore or cloudflare witness)
  - `revocation_evidence` (serialized revocation list + its own proof)
- `SnpEvidence`:
  - `report` (bytes — the raw AMD SEV-SNP attestation report, fixed binary layout per AMD spec §7.3)
  - `certs: AmdSevSnpCertChain { vcek_pem, ask_pem, crl }`
- `ReportDataInput { x25519_public_key, client_nonce }` — the input the
  server hashed into `report_data` to prove freshness against our msg1 nonce.

## What verification actually requires

For hard verification (not just "parse and log"):

1. **Parse the SNP report.** Fixed-layout binary per AMD "SEV Secure Nested
   Paging — Firmware ABI Specification", table 22 ("ATTESTATION_REPORT
   structure"). ~1200 bytes. Need to pull out `measurement`,
   `host_data`, `id_key_digest`, `report_data`, and the ECDSA-P384 signature.
2. **Verify `report_data` matches our handshake state.** Compute `sha384(
   x25519_public_key || client_nonce)` (or whatever combinator the
   `ReportDataInput` proto implies) and compare. This is the freshness
   check — binds the attestation to msg1.
3. **Verify VCEK signs the report.** ECDSA-P384. `@noble/curves` has P384.
4. **Verify ASK signs VCEK.** Also ECDSA-P384.
5. **Verify ARK signs ASK.** ARK is AMD's root. Public key is hardcoded
   in AMD's "AMD SEV Key Distribution Service" docs — ship it as a
   constant in the repo.
6. **Check VCEK against the CRL.** Parse `crl` (likely CRLite or AMD's
   proprietary format), confirm the VCEK serial isn't revoked.
7. **Verify the transparency proof.** Either sigstore witness bundle OR
   cloudflare witness bundle (oneof). Each is a separate format.
8. **Verify the revocation evidence.** `RevocationEvidence` has its own
   transparency proof, same choice.
9. **Check `image_manifest` against a known good value.** This is the
   "which VM image did Meta actually load" check. Without a catalog of
   trusted manifests, this reduces to "is the manifest's TUF signature
   valid".

## Why this didn't ship today

No captured msg2 bundle on disk — the recon phase didn't preserve one, and
I didn't want to ship a parser I couldn't exercise end-to-end against real
data. AMD SNP report parsing is fiddly enough that "it compiles" is not
evidence of correctness; need at least one real sample bundle to validate
every field offset.

Also — scope realism. The old phases-overview estimate was "3-5 days"
based on the (wrong) ed25519 assumption. With AMD SNP + CRL + transparency
proofs, realistic estimate is **1-2 weeks** of careful work. Shipping a
broken version is strictly worse than shipping nothing.

## What to do next (when someone picks this up)

1. **Capture a real msg2 bundle first.** Modify `src/noise/handshake.ts`'s
   `readMessage2` to dump the decrypted plaintext to a file (behind a
   `DUMP_ATTESTATION=1` env var). Run bootstrap once, save the ~70-byte
   bundle, delete the env var.
2. **Parse the SnpEvidence.report** using the AMD spec. Verify field
   offsets against the capture.
3. **Pull AMD ARK + ASK from amd.com.** Pin the ARK public key as a repo
   constant.
4. **Ship step-wise:** parse + log (no fail) → verify-report-data (log
   mismatch) → verify VCEK sig (log mismatch) → full chain enforcement.
5. **Risk mitigation while unverified:** current code already notes the
   gap in `docs/security.md`. Nothing changes until step 4.

## Deferred, not forgotten

Updated `docs/phases-overview.md` + `docs/specs/02-10-2026-node-port-design.md`
to correct the ed25519-chain misdescription. The actual item is on the
future-work list but no longer sized wrong.

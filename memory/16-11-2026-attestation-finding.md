# Attestation finding — muse runs NON_TEE (16-11-2026)

## Goal

Parse the captured `attestation-dump.json` (step 2 of Phase 8) and validate
the SNP report parser. Expected to find an AMD SEV-SNP report to work
against; instead found that muse is **not** running confidential compute
for this account right now.

## What the capture actually contains

Bundle wire size: **70 bytes** (vs ~2000+ expected for a real SnpEvidence
with cert chain + CRL). Decoded as `thatch.attestation.v1.AttestationBundle`:

- `platform: 0` → `NON_TEE`. The AMD_SEV_SNP (=1) enum value never fires.
- `report_data_input: 68 bytes` — a serialized `ReportDataInput` proto,
  decodes to `{x25519_public_key: 32B, client_nonce: 32B}`. This is
  present even in NON_TEE mode.
- `snp: (absent)` — the oneof `evidence { snp }` has no branch set.
  There is no signed report, no VCEK chain, no CRL, no transparency
  proof.
- `image_manifest: (absent)`.

## Freshness — half-confirmed

| Field | Match? | Note |
|---|---|---|
| `ReportDataInput.client_nonce` == our msg1 nonce | **yes** | server echoes the exact 32 bytes we sent |
| `ReportDataInput.x25519_public_key` == our ephemeral e | no | — |
| `ReportDataInput.x25519_public_key` == server ephemeral e | no | — |
| `ReportDataInput.x25519_public_key` == server static rs | unknown | rs wasn't in the dump; need a recapture |

The server is echoing OUR client_nonce back verbatim, so it has at least
seen our msg1. It also includes an `x25519_public_key` which is almost
certainly the server's LONG-LIVED Noise static key (`rs`) — the one we'd
want committed in an attestation if one existed. The dump now also writes
`server_static_pub_b64` from `XxInitiator.peekRemoteStatic()` so the next
capture can confirm this equality.

## What this means for Phase 8

The 1-2 week sizing estimate from the earlier scoping memo is **moot for
muse's current deployment**. There is no SNP evidence to verify. The
`AttestationBundle` payload reduces to "here is what I'd put in the report
if I had a report".

Implications:

1. **MITM protection = TLS to `hatch.metaaivm.com`, nothing more.** The
   Noise static key has no hardware root of trust in this deployment.
   Matches what `docs/security.md` already assumed.
2. **The SNP parser is still useful.** If muse ever flips to confidential
   VMs (`platform=1`), `parseSnpReport` is ready and tested. The parser
   lives in `src/noise/attestation.ts` and `tests/attestation.test.ts`
   validates every field offset with synthetic values.
3. **The "verify report_data matches our handshake" check is possible
   even now** — but the server committing a value in `report_data_input`
   without signing it buys us nothing. It would only matter if the SNP
   path lit up.

## What I actually shipped

- `src/noise/attestation.ts` — `parseAttestationBundle`,
  `parseReportDataInput`, and `parseSnpReport` with AMD-spec field
  offsets. Ready for the SNP path.
- `src/cli/inspect-attestation.ts` + `npm run inspect:attestation` —
  reads `attestation-dump.json`, reports platform, decodes the
  `ReportDataInput`, checks three freshness conditions, parses the SNP
  report if present.
- `XxInitiator.peekRemoteStatic()` — exposes `rs` for the dump path. No
  behavioural change outside `DUMP_ATTESTATION=1`.
- Dump payload gained `server_static_pub_b64` so the pub-key echo hypothesis
  can be confirmed on the next capture.
- `tests/attestation.test.ts` — synthetic report with known-value fields,
  asserts every offset. 82/82 total tests pass.

## What's next

1. Recapture with the updated dump (includes `server_static_pub_b64`) to
   confirm `ReportDataInput.x25519_public_key == server static key`.
2. If muse eventually enables confidential VMs: the parser runs, the CLI
   prints SNP report fields, next step is ECDSA-P384 chain verification
   (VCEK → ASK → ARK). Still 1-2 weeks of work, but unblocked structurally.
3. In the meantime: Phase 8 is deferred by **muse's choice**, not ours.
   The gap is real but the work is on their side.

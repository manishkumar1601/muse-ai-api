"""Pull every `fileDesc("<base64>")` call out of the Hatch JS chunks and dump each
as a raw FileDescriptorProto .binpb next to a decoded .proto for human reading.

The browser bundle registers protobuf schemas via `(0,X.fileDesc)("<base64 of FileDescriptorProto>")`.
That base64 blob is exactly `FileDescriptorProto` wire bytes (per @bufbuild/protobuf's `fileDesc` API).
We don't have the matching .proto source, but we have the descriptor bytes — same data, machine-readable.

Usage:
    python extract_protos.py                       # defaults
    python extract_protos.py --chunks ../recon/chunks --out ./protos
"""

import argparse
import base64
import re
import sys
from pathlib import Path

# fileDesc("...") OR (0,ident.fileDesc)("...")  — handles both minified calling conventions
FILE_DESC_RE = re.compile(r'(?:\(0,[A-Za-z_$][A-Za-z0-9_$]*\.fileDesc\)|\bfileDesc)\("([A-Za-z0-9+/=_\-]+)"\)')


def is_valid_descriptor(blob: bytes) -> tuple[bool, str]:
    """Minimal sanity: FileDescriptorProto starts with field 1 (name, string) = tag 0x0a."""
    if len(blob) < 4:
        return False, "too short"
    if blob[0] != 0x0A:
        return False, f"first byte 0x{blob[0]:02x} != 0x0a (expected FileDescriptorProto.name tag)"
    try:
        name_len = blob[1]
        if name_len == 0 or name_len > 200:
            return False, f"name length {name_len} suspicious"
        name = blob[2:2 + name_len].decode("utf-8")
        if not name.endswith(".proto"):
            return False, f"name '{name}' doesn't end with .proto"
        return True, name
    except (IndexError, UnicodeDecodeError) as e:
        return False, f"name parse: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", default="../recon/chunks", help="dir with the JS chunks")
    ap.add_argument("--out", default="./protos", help="output dir for descriptor files")
    ap.add_argument("--scan-all", action="store_true",
                    help="also scan every chunk under ../recon/chunk_urls.txt (requires download)")
    args = ap.parse_args()

    chunk_dir = Path(args.chunks)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not chunk_dir.exists():
        print(f"chunks dir missing: {chunk_dir}", file=sys.stderr)
        sys.exit(2)

    seen: dict[str, bytes] = {}
    chunk_source: dict[str, list[str]] = {}

    files = sorted(chunk_dir.glob("*.js"))
    print(f"scanning {len(files)} chunks under {chunk_dir}", file=sys.stderr)

    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        matches = FILE_DESC_RE.findall(text)
        for b64 in matches:
            # bufbuild uses standard base64, sometimes URL-safe. Try both.
            raw: bytes | None = None
            for decoder in (base64.b64decode, base64.urlsafe_b64decode):
                try:
                    raw = decoder(b64 + "=" * (-len(b64) % 4))
                    break
                except Exception:
                    continue
            if raw is None:
                print(f"  [{f.name}] base64 decode failed", file=sys.stderr)
                continue
            ok, info = is_valid_descriptor(raw)
            if not ok:
                print(f"  [{f.name}] skipped: {info}", file=sys.stderr)
                continue
            name = info  # e.g. "noise_envelope.proto"
            if name not in seen:
                seen[name] = raw
                chunk_source[name] = []
            chunk_source[name].append(f.name)

    print(f"\nextracted {len(seen)} unique FileDescriptorProto blobs:\n", file=sys.stderr)
    for name in sorted(seen):
        safe = name.replace("/", "__")
        bin_path = out_dir / f"{safe}.binpb"
        bin_path.write_bytes(seen[name])
        print(f"  {len(seen[name]):6d} B  {name:50s}  (in: {','.join(chunk_source[name][:2])}{'...' if len(chunk_source[name])>2 else ''})")
        print(f"           -> {bin_path}")

    # Also stitch into a single FileDescriptorSet for easy protoc use
    # FileDescriptorSet { repeated FileDescriptorProto file = 1; }
    set_bytes = bytearray()
    for name in sorted(seen):
        blob = seen[name]
        # field 1 (file), wire-type 2 (length-delimited)
        set_bytes.append(0x0A)
        # varint-encode length
        n = len(blob)
        while True:
            b = n & 0x7F
            n >>= 7
            if n:
                set_bytes.append(b | 0x80)
            else:
                set_bytes.append(b)
                break
        set_bytes.extend(blob)
    set_path = out_dir / "_all.descset"
    set_path.write_bytes(bytes(set_bytes))
    print(f"\nwrote combined FileDescriptorSet: {set_path} ({len(set_bytes)} B)")
    print("\nnext step: inspect with:")
    print(f"  protoc --decode_raw < {set_path}       # dumps structure")
    print(f"  python -m google.protobuf <schema>     # if you have google.protobuf installed")


if __name__ == "__main__":
    main()

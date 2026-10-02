"""Dump the Hatch .binpb FileDescriptorProto blobs as readable .proto source.

We don't ship a code generator. We render field names, types, oneofs, and enums
into a .proto-like text — good enough to see what messages exist and craft requests.

Output: for each ../phase2/protos/<name>.binpb, write ./schemas/<name>.proto
"""

from pathlib import Path
import sys

from google.protobuf import descriptor_pb2


# Mapping from protobuf wire-type enum ints to .proto source names
TYPE = {
    1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 6: "fixed64", 7: "fixed32",
    8: "bool", 9: "string", 10: "group", 11: "message", 12: "bytes", 13: "uint32",
    14: "enum", 15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64",
}


def strip_leading_dot(s: str) -> str:
    return s.lstrip(".")


def render_enum(e: descriptor_pb2.EnumDescriptorProto, indent: str) -> str:
    out = [f"{indent}enum {e.name} {{"]
    for v in e.value:
        out.append(f"{indent}  {v.name} = {v.number};")
    out.append(f"{indent}}}")
    return "\n".join(out)


def render_message(m: descriptor_pb2.DescriptorProto, indent: str = "") -> str:
    out = [f"{indent}message {m.name} {{"]
    inner = indent + "  "

    # Nested enums / messages first
    for ne in m.enum_type:
        out.append(render_enum(ne, inner))
    for nm in m.nested_type:
        out.append(render_message(nm, inner))

    # Group fields by oneof_index
    oneof_names = [o.name for o in m.oneof_decl]
    oneof_fields: dict[int, list] = {i: [] for i in range(len(oneof_names))}
    scalar_fields = []
    for f in m.field:
        if f.HasField("oneof_index") and not getattr(f, "proto3_optional", False):
            oneof_fields[f.oneof_index].append(f)
        else:
            scalar_fields.append(f)

    def _field_line(f) -> str:
        label = ""
        if f.label == 3:  # LABEL_REPEATED
            label = "repeated "
        elif getattr(f, "proto3_optional", False):
            label = "optional "
        if f.type in (11, 14):  # message or enum
            t = strip_leading_dot(f.type_name)
        else:
            t = TYPE.get(f.type, f"?{f.type}")
        return f"{label}{t} {f.name} = {f.number};"

    for f in scalar_fields:
        out.append(f"{inner}{_field_line(f)}")

    for i, name in enumerate(oneof_names):
        out.append(f"{inner}oneof {name} {{")
        for f in oneof_fields[i]:
            out.append(f"{inner}  {_field_line(f)}")
        out.append(f"{inner}}}")

    out.append(f"{indent}}}")
    return "\n".join(out)


def render_file(fdp: descriptor_pb2.FileDescriptorProto) -> str:
    lines = []
    syntax = fdp.syntax or "proto2"
    lines.append(f'syntax = "{syntax}";')
    if fdp.package:
        lines.append(f"package {fdp.package};")
    lines.append("")
    if fdp.dependency:
        for d in fdp.dependency:
            lines.append(f'import "{d}";')
        lines.append("")
    for e in fdp.enum_type:
        lines.append(render_enum(e, ""))
        lines.append("")
    for m in fdp.message_type:
        lines.append(render_message(m, ""))
        lines.append("")
    return "\n".join(lines)


def main():
    src_dir = Path("../phase2/protos")
    out_dir = Path("./schemas")
    out_dir.mkdir(parents=True, exist_ok=True)

    binpbs = sorted(src_dir.glob("*.binpb"))
    if not binpbs:
        print(f"no .binpb files under {src_dir}", file=sys.stderr)
        sys.exit(2)

    for b in binpbs:
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.ParseFromString(b.read_bytes())
        text = render_file(fdp)
        proto_name = fdp.name.replace("/", "__")
        out = out_dir / proto_name
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out}  ({len(text)} chars)")

    print(f"\n--- combined view ---")
    for b in binpbs:
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.ParseFromString(b.read_bytes())
        print(f"\n### {fdp.name} ###\n")
        print(render_file(fdp))


if __name__ == "__main__":
    main()

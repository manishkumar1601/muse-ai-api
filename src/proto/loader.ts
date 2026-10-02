import protobuf from "protobufjs";
import { type Root } from "protobufjs";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ponytail: `as unknown as X` cast is the one sanctioned place where strict TS and the
// CJS descriptor ext clash. The ext module exports named props on its default export;
// the .d.ts types them correctly but esModuleInterop + verbatimModuleSyntax make a
// named-type import the cleanest path without fighting the module system.
import descriptor from "protobufjs/ext/descriptor/index.js";

const { FileDescriptorProto, FileDescriptorSet } = descriptor as unknown as {
  FileDescriptorProto: protobuf.Type;
  FileDescriptorSet: protobuf.Type;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "schemas");

let cached: Root | null = null;

export function loadSchemas(): Root {
  if (cached) return cached;
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".binpb")).sort();
  const descriptors = files.map((f) =>
    FileDescriptorProto.decode(readFileSync(join(SCHEMA_DIR, f)))
  );
  const set = FileDescriptorSet.create({ file: descriptors });
  // ponytail: fromDescriptor+resolveAll return Namespace in the .d.ts but it's
  // always the same Root instance at runtime — cast once here, done.
  cached = (protobuf.Root as unknown as { fromDescriptor(s: protobuf.Message): { resolveAll(): Root } })
    .fromDescriptor(set)
    .resolveAll();
  return cached as Root;
}

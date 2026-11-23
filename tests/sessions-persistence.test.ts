import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/hatch/sessions.js";

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-sessions-")), "sessions-store.json");
}

test("session mapping persists across store instances (resume after restart)", () => {
  const path = tmpStorePath();
  const first = new SessionStore(60_000, 100, path);
  const created = first.get("h:my-project");
  assert.ok(created.sessionId);

  // Simulate a proxy restart: a brand-new store over the same file must
  // hand back the SAME sessionId/nodeId, so the same muse.ai side chat
  // is resumed instead of a new one being created.
  const second = new SessionStore(60_000, 100, path);
  const resumed = second.get("h:my-project");
  assert.equal(resumed.sessionId, created.sessionId);
  assert.equal(resumed.nodeId, created.nodeId);
});

test("persisted store file is owner-only JSON keyed by session key", () => {
  const path = tmpStorePath();
  const s = new SessionStore(60_000, 100, path);
  s.get("h:abc");
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, { sessionId: string }>;
  assert.ok(raw["h:abc"]?.sessionId);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o077, 0, "store file must not be group/world readable");
  }
});

test("expired entries are not resurrected from disk", () => {
  const path = tmpStorePath();
  // Seed the file by hand with an entry whose lastUsed is far past the TTL.
  writeFileSync(path, JSON.stringify({
    "h:short-lived": { sessionId: "old-session-id", nodeId: "old-node-id", lastUsed: Date.now() - 100_000 },
  }));
  const s = new SessionStore(1_000, 100, path);
  const after = s.get("h:short-lived");
  assert.notEqual(after.sessionId, "old-session-id");
});

test("corrupt store file is ignored, store still works", () => {
  const path = tmpStorePath();
  writeFileSync(path, "{not json!!");
  const s = new SessionStore(60_000, 100, path);
  const state = s.get("h:anything");
  assert.ok(state.sessionId);
});

test("no persistPath means in-memory only (no file created)", () => {
  const s = new SessionStore();
  assert.ok(s.get("h:x").sessionId);
});

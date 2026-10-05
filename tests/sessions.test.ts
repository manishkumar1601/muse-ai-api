import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore, deriveSessionKey, DEFAULT_SESSION_KEY } from "../src/hatch/sessions.js";
import { sendAndCollectReply } from "../src/hatch/chat.js";

test("deriveSessionKey prefers X-Muse-Session over Authorization", () => {
  assert.equal(deriveSessionKey({ xMuseSession: "abc" }), "h:abc");
  assert.equal(deriveSessionKey({ xMuseSession: "abc", authorization: "Bearer x" }), "h:abc");
  assert.ok(deriveSessionKey({ authorization: "Bearer x" }).startsWith("a:"));
  assert.equal(deriveSessionKey({}), DEFAULT_SESSION_KEY);
  // whitespace ignored
  assert.equal(deriveSessionKey({ xMuseSession: "   " }), DEFAULT_SESSION_KEY);
});

test("deriveSessionKey is stable for same Authorization", () => {
  const a = deriveSessionKey({ authorization: "Bearer same" });
  const b = deriveSessionKey({ authorization: "Bearer same" });
  assert.equal(a, b);
  const c = deriveSessionKey({ authorization: "Bearer different" });
  assert.notEqual(a, c);
});

test("SessionStore returns stable sessionId per key", () => {
  const s = new SessionStore();
  const a = s.get("k1");
  assert.ok(a.sessionId.length > 0);
  assert.ok(a.nodeId.length > 0);
  const b = s.get("k1");
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.nodeId, b.nodeId);
  const c = s.get("k2");
  assert.notEqual(a.sessionId, c.sessionId);
});

test("SessionStore evicts after TTL and mints fresh sessionId on next get", async () => {
  const s = new SessionStore(10, 100);
  const first = s.get("k").sessionId;
  await new Promise((r) => setTimeout(r, 25));
  s.get("other");
  const second = s.get("k").sessionId;
  assert.notEqual(first, second);
});

test("SessionStore enforces max entries", () => {
  const s = new SessionStore(60_000, 2);
  s.get("a"); s.get("b"); s.get("c");
  assert.ok(s.size() <= 2);
});

test("sendAndCollectReply writes session_id + metadata into stream body when sessionState provided", async () => {
  const nowMs = Date.now();
  let captured: Record<string, unknown> | undefined;
  const mockClient = {
    request: (_v: string, path: string, body?: unknown) => {
      if (path === "/chat/stream") captured = body as Record<string, unknown>;
      return 1n;
    },
    hasResponded: () => true,
    async recvOne() {
      const ev = { ts_ms: nowMs + 10, event: "delta.message_done", payload: { transcript: { messages: [{ content: [{ type: "text", text: "ok" }] }] } } };
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "event" as const, streamId: 1n, obj: ev as Record<string, unknown> };
    },
    async close() {},
  };
  await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi",
    timezone: "UTC",
    listenMs: 2000,
    sessionState: { sessionId: "sess-A", nodeId: "n1", lastUsed: Date.now() },
  });
  assert.ok(captured);
  assert.equal(captured["session_id"], "sess-A");
  assert.deepEqual(captured["metadata"], { thread_is_dictation_used: false });
});

test("sendAndCollectReply omits session_id when no sessionState (main chat)", async () => {
  const nowMs = Date.now();
  let captured: Record<string, unknown> | undefined;
  const mockClient = {
    request: (_v: string, path: string, body?: unknown) => {
      if (path === "/chat/stream") captured = body as Record<string, unknown>;
      return 1n;
    },
    hasResponded: () => true,
    async recvOne() {
      const ev = { ts_ms: nowMs + 10, event: "delta.message_done", payload: { transcript: { messages: [{ content: [{ type: "text", text: "ok" }] }] } } };
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "event" as const, streamId: 1n, obj: ev as Record<string, unknown> };
    },
    async close() {},
  };
  await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.ok(captured);
  assert.equal(captured["session_id"], undefined);
  assert.equal(captured["metadata"], undefined);
});

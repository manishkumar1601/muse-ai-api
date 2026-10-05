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

test("SessionStore returns fresh state with nodeId", () => {
  const s = new SessionStore();
  const a = s.get("k1");
  assert.ok(a.nodeId.length > 0);
  assert.equal(a.sessionId, undefined);
  assert.equal(a.channel, undefined);
  const b = s.get("k1");
  assert.equal(a.nodeId, b.nodeId); // same key → same state
  const c = s.get("k2");
  assert.notEqual(a.nodeId, c.nodeId); // different key → different nodeId
});

test("SessionStore.update merges patch", () => {
  const s = new SessionStore();
  s.get("k");
  s.update("k", { sessionId: "sess-1", channel: "side-xyz" });
  const r = s.get("k");
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.channel, "side-xyz");
});

test("SessionStore evicts after TTL", async () => {
  const s = new SessionStore(10, 100);
  s.get("k");
  assert.equal(s.size(), 1);
  await new Promise((r) => setTimeout(r, 25));
  s.get("other"); // triggers sweep
  assert.equal(s.size(), 1);
  const now = s.get("k"); // k was evicted, recreated
  assert.equal(now.sessionId, undefined);
});

test("SessionStore enforces max entries", () => {
  const s = new SessionStore(60_000, 2);
  s.get("a"); s.get("b"); s.get("c");
  assert.ok(s.size() <= 2);
});

test("sendAndCollectReply writes session_id and channel into stream body when state carries them", async () => {
  const nowMs = Date.now();
  let captured: Record<string, unknown> | undefined;
  const mockClient = {
    request: (_v: string, path: string, body?: unknown) => {
      if (path === "/chat/stream") captured = body as Record<string, unknown>;
      return 1n;
    },
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
    sessionState: { nodeId: "n1", sessionId: "sess-A", channel: "side-A", lastUsed: Date.now() },
  });
  assert.ok(captured);
  assert.equal(captured["session_id"], "sess-A");
  assert.equal(captured["channel"], "side-A");
});

test("sendAndCollectReply omits session_id/channel when state is empty", async () => {
  const nowMs = Date.now();
  let captured: Record<string, unknown> | undefined;
  const mockClient = {
    request: (_v: string, path: string, body?: unknown) => {
      if (path === "/chat/stream") captured = body as Record<string, unknown>;
      return 1n;
    },
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
  assert.equal(captured["channel"], undefined);
});

test("sendAndCollectReply surfaces session_id/channel from ack body", async () => {
  const nowMs = Date.now();
  const mockClient = {
    request: () => 1n,
    _step: 0,
    async recvOne() {
      this._step++;
      if (this._step === 1) {
        return { kind: "complete" as const, streamId: 1n, body: { session_id: "SESS-123", channel: "chan-9", message_id: "m-1" } };
      }
      const ev = { ts_ms: nowMs + 10, event: "delta.message_done", payload: { transcript: { messages: [{ content: [{ type: "text", text: "ok" }] }] } } };
      return { kind: "event" as const, streamId: 1n, obj: ev as Record<string, unknown> };
    },
    async close() {},
  };
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.equal(r.sessionId, "SESS-123");
  assert.equal(r.channel, "chan-9");
  assert.equal(r.messageId, "m-1");
});

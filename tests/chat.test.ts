import { test } from "node:test";
import assert from "node:assert/strict";
import { MuseChatTimeoutError, sendAndCollectReply } from "../src/hatch/chat.js";

// Minimal mock: tracks requested sids, keeps a per-sid event queue so the
// multiplex-aware sendAndCollectReply gets the right events on the right sid.
function makeMock(opts: { subscribeEvents: Array<Record<string, unknown>>; ackMessageId?: string }) {
  let streamId = 0n;
  const queues = new Map<bigint, Array<unknown>>();
  let subscribeSid: bigint | null = null;
  let sendSid: bigint | null = null;

  const push = (sid: bigint, v: unknown) => {
    const q = queues.get(sid) ?? [];
    q.push(v);
    queues.set(sid, q);
  };

  return {
    request: (verb: string, path: string): bigint => {
      streamId++;
      const sid = streamId;
      if (path === "/chat/subscribe") {
        subscribeSid = sid;
        for (const e of opts.subscribeEvents) push(sid, { kind: "event", streamId: sid, obj: e });
      } else if (path === "/chat/stream") {
        sendSid = sid;
        if (opts.ackMessageId !== undefined) {
          push(sid, { kind: "complete", streamId: sid, status: 200, body: { message_id: opts.ackMessageId } });
        }
      }
      return sid;
    },
    hasResponded: () => true,
    async recvOne(sid: bigint) {
      const q = queues.get(sid);
      if (!q || q.length === 0) return "closed" as const;
      return q.shift() as { kind: string; streamId: bigint; obj?: Record<string, unknown>; body?: unknown; status?: number };
    },
    async close() {},
    get subscribeSid() { return subscribeSid; },
    get sendSid() { return sendSid; },
  };
}

test("sendAndCollectReply assembles delta.text_append chunks", async () => {
  const nowMs = Date.now();
  const mockClient = makeMock({
    subscribeEvents: [
      { ts_ms: nowMs - 10_000, event: "delta.text_append", payload: { text: "OLD-REPLAY" } },
      { ts_ms: nowMs + 5,    event: "message.user",      payload: {} },
      { ts_ms: nowMs + 10,   event: "delta.text_append", payload: { text: "hello " } },
      { ts_ms: nowMs + 15,   event: "delta.text_append", payload: { text: "world" } },
      { ts_ms: nowMs + 20,   event: "delta.message_done", payload: {} },
    ],
    ackMessageId: "ack-123",
  });

  const chunks: string[] = [];
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi",
    timezone: "UTC",
    listenMs: 2000,
    onDelta: (c) => chunks.push(c),
  });

  assert.equal(r.replyText, "hello world");
  assert.deepEqual(chunks, ["hello ", "world"]);
});

test("sendAndCollectReply falls back to transcript when no delta.text_append", async () => {
  const nowMs = Date.now();
  const mockClient = makeMock({
    subscribeEvents: [
      { ts_ms: nowMs + 5, event: "delta.message_done", payload: {
        transcript: { messages: [{ content: [{ type: "text", text: "whole answer" }] }] }
      } },
    ],
  });

  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.equal(r.replyText, "whole answer");
});

test("sendAndCollectReply repairs missed deltas from final transcript", async () => {
  const nowMs = Date.now();
  const mockClient = makeMock({
    subscribeEvents: [
      { ts_ms: nowMs + 5000, event: "delta.text_append", payload: { text: "complete" } },
      { ts_ms: nowMs + 5010, event: "delta.message_done", payload: {
        transcript: { messages: [{ content: [{ type: "text", text: "complete answer" }] }] },
      } },
    ],
  });
  const chunks: string[] = [];
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000, onDelta: (c) => chunks.push(c),
  });
  assert.equal(r.replyText, "complete answer");
  assert.deepEqual(chunks, ["complete", " answer"]);
});

test("sendAndCollectReply returns when final event arrives before delayed ack", async () => {
  const nowMs = Date.now();
  let delayedAckTimeout = 0;
  const mockClient = {
    request: (_verb: string, path: string) => path === "/chat/stream" ? 4n : path === "/chat/subscribe" ? 3n : 1n,
    hasResponded: () => true,
    async recvOne(sid: bigint, timeoutMs = 1500) {
      if (sid === 3n) return {
        kind: "event" as const,
        streamId: sid,
        obj: { ts_ms: nowMs + 5000, event: "delta.message_done", payload: { transcript: { messages: [{ content: [{ type: "text", text: "done" }] }] } } },
      };
      delayedAckTimeout = timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    },
  };
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.equal(r.replyText, "done");
  assert.ok(delayedAckTimeout <= 1500);
});

test("sendAndCollectReply tolerates small clock skew on fresh Muse events", async () => {
  const nowMs = Date.now();
  const mockClient = makeMock({
    subscribeEvents: [
      { ts_ms: nowMs - 2000, event: "delta.message_done", payload: {
        transcript: { messages: [{ content: [{ type: "text", text: "reply" }] }] },
      } },
    ],
  });
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.equal(r.replyText, "reply");
});

test("sendAndCollectReply rejects timed out partial main-chat output", async () => {
  const mockClient = {
    request: (_verb: string, path: string) => path === "/chat/stream" ? 4n : path === "/chat/subscribe" ? 3n : 1n,
    hasResponded: () => true,
    async recvOne(sid: bigint) {
      if (sid === 3n) return { kind: "event" as const, streamId: sid, obj: { event: "delta.text_append", payload: { text: "partial" } } };
      if (sid === 4n) return { kind: "complete" as const, streamId: sid, status: 200, body: { message_id: "sent-1" } };
      return null;
    },
  };
  await assert.rejects(sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 30,
  }), MuseChatTimeoutError);
});

test("side-chat timeout does not return partial history as complete reply", async () => {
  let nextSid = 0n;
  const mockClient = {
    request: (_verb: string, _path: string) => ++nextSid,
    async recvOne(sid: bigint) {
      if (sid === 2n) return { kind: "complete" as const, streamId: sid, status: 200, body: { message_id: "sent-1" } };
      if (sid > 2n) return { kind: "complete" as const, streamId: sid, status: 200, body: { result: { chat_events: [
        { event_name: "message.user", message_id: "sent-1" },
        { event_name: "message.assistant", display_text: "partial" },
      ] } } };
      return null;
    },
  };
  await assert.rejects(sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 100,
    sessionState: { sessionId: "thread-1", nodeId: "node-1", lastUsed: Date.now() },
  }), MuseChatTimeoutError);
});

test("side-chat history uses latest assistant snapshot after this user message", async () => {
  let nextSid = 0n;
  const ackId = "user-1";
  const history = {
    result: { chat_events: [
      { event_name: "message.user", message_id: ackId },
      { event_name: "message.assistant", message_id: "assistant-1", display_text: "early" },
      { event_name: "message.assistant", message_id: "assistant-1", display_text: "complete answer" },
    ] },
  };
  const mockClient = {
    request: (_verb: string, _path: string) => ++nextSid,
    async recvOne(sid: bigint) {
      if (sid === 2n) return { kind: "complete" as const, streamId: sid, status: 200, body: { message_id: ackId } };
      if (sid > 2n) return { kind: "complete" as const, streamId: sid, status: 200, body: history };
      return null;
    },
  };
  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 3000,
    sessionState: { sessionId: "thread-1", nodeId: "node-1", lastUsed: Date.now() },
  });
  assert.equal(r.replyText, "complete answer");
});

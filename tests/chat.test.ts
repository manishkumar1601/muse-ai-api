import { test } from "node:test";
import assert from "node:assert/strict";
import { sendAndCollectReply } from "../src/hatch/chat.js";

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
      { ts_ms: nowMs - 1000, event: "delta.text_append", payload: { text: "OLD-REPLAY" } },
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendAndCollectReply } from "../src/hatch/chat.js";

test("sendAndCollectReply assembles delta.text_append chunks", async () => {
  const nowMs = Date.now();
  const events = [
    { ts_ms: nowMs - 1000, event: "delta.text_append", payload: { text: "OLD-REPLAY" } }, // dropped
    { ts_ms: nowMs + 5,    event: "message.user",      payload: {} },
    { ts_ms: nowMs + 10,   event: "delta.text_append", payload: { text: "hello " } },
    { ts_ms: nowMs + 15,   event: "delta.text_append", payload: { text: "world" } },
    { ts_ms: nowMs + 20,   event: "delta.message_done", payload: {} },
  ];
  const q = [...events];
  let streamId = 0n;

  const mockClient = {
    request: () => { streamId++; return streamId; },
    async recvOne() {
      const e = q.shift();
      if (!e) return "closed" as const;
      return { kind: "event" as const, streamId: 1n, obj: e as Record<string, unknown> };
    },
    async close() {},
  };

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
  const events = [
    { ts_ms: nowMs + 5, event: "delta.message_done", payload: {
      transcript: { messages: [{ content: [{ type: "text", text: "whole answer" }] }] }
    } },
  ];
  const q = [...events];

  const mockClient = {
    request: () => 1n,
    async recvOne() {
      const e = q.shift();
      if (!e) return "closed" as const;
      return { kind: "event" as const, streamId: 1n, obj: e as Record<string, unknown> };
    },
    async close() {},
  };

  const r = await sendAndCollectReply({
    client: mockClient as unknown as import("../src/hatch/client.js").HatchClient,
    userText: "hi", timezone: "UTC", listenMs: 2000,
  });
  assert.equal(r.replyText, "whole answer");
});

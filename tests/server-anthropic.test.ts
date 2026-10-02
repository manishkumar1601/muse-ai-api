import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

test("POST /v1/messages non-stream returns Anthropic shape", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "hi", messageId: "fx-id" }),
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "muse-spark", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { type: string; content: Array<{ type: string; text: string }>; stop_reason: string };
  assert.equal(body.type, "message");
  assert.equal(body.content[0]!.type, "text");
  assert.equal(body.content[0]!.text, "hi");
  assert.equal(body.stop_reason, "end_turn");
});

test("POST /v1/messages/count_tokens returns input_tokens >= 1", async () => {
  const app = createApp({ runChat: async () => ({ replyText: "", messageId: "x" }) });
  const res = await app.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello world" }], system: "be helpful" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { input_tokens: number };
  assert.ok(body.input_tokens >= 1);
});

test("POST /v1/messages with empty messages → 400", async () => {
  const app = createApp({ runChat: async () => ({ replyText: "", messageId: "x" }) });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
});

test("POST /v1/messages stream emits event: message_start / content_block_delta / message_stop", async () => {
  const app = createApp({
    runChat: async (_text, onDelta) => {
      onDelta?.("hello ");
      onDelta?.("world");
      return { replyText: "hello world", messageId: "stream-msg" };
    },
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("event: message_start"));
  assert.ok(text.includes("event: content_block_start"));
  assert.ok(text.includes('"text":"hello "'));
  assert.ok(text.includes('"text":"world"'));
  assert.ok(text.includes("event: content_block_stop"));
  assert.ok(text.includes("event: message_delta"));
  assert.ok(text.includes("event: message_stop"));
});

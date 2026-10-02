import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

test("/v1/chat/completions non-stream returns chat.completion shape", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "hello", messageId: "fixed-id" }),
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "muse-spark", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { object: string; choices: Array<{ message: { content: string } }> };
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0]!.message.content, "hello");
});

test("/v1/chat/completions empty messages → 400", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "", messageId: "x" }),
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
});

test("/v1/models returns one entry", async () => {
  const app = createApp({ runChat: async () => ({ replyText: "", messageId: "x" }) });
  const res = await app.request("/v1/models");
  const body = await res.json() as { data: Array<{ id: string }> };
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]!.id, "muse-spark");
});

test("/v1/chat/completions stream emits SSE chunks", async () => {
  const app = createApp({
    runChat: async (_text, onDelta) => {
      onDelta?.("hello ");
      onDelta?.("world");
      return { replyText: "hello world", messageId: "stream-id" };
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type")?.toLowerCase().includes("text/event-stream"), true);
  const text = await res.text();
  assert.ok(text.includes("role"), "first chunk should have role");
  assert.ok(text.includes("hello "), "should include first delta");
  assert.ok(text.includes("world"), "should include second delta");
  assert.ok(text.includes('"finish_reason":"stop"'), "should have finish_reason stop");
  assert.ok(text.includes("[DONE]"), "should end with [DONE]");
});

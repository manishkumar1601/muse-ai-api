import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

test("non-stream handler returns 502 + OpenAI error shape when bootstrap fails", async () => {
  const app = createApp({
    runChat: async () => { throw new Error("test failure — simulate bootstrap failed"); },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 502);
  const body = await res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "server_error");
});

test("Anthropic non-stream handler returns 503 + Anthropic error envelope when runChat throws", async () => {
  const app = createApp({
    runChat: async () => { throw new Error("simulated"); },
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 503);
  const body = await res.json() as { type: string; error: { type: string; message: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "api_error");
});

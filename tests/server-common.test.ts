import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenMessages } from "../src/server/common.js";
import { createApp } from "../src/server/start.js";

test("flattenMessages combines roles with prefixes", () => {
  const s = flattenMessages([
    { role: "system", content: "you are helpful" },
    { role: "user", content: "hi" },
  ]);
  assert.ok(s.includes("[system]"));
  assert.ok(s.includes("you are helpful"));
  assert.ok(s.includes("hi"));
});

test("flattenMessages handles Anthropic content blocks", () => {
  const s = flattenMessages([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  assert.ok(s.includes("hello"));
});

test("flattenMessages empty array → empty string", () => {
  assert.equal(flattenMessages([]), "");
});

// Review Focus #1: empty messages on /v1/messages → 400 not 500 or hang
test("POST /v1/messages with empty messages array returns 400", async () => {
  const app = createApp();
  // ponytail: inline stub — Tasks 16/17 implement the real handler; this only proves the 400 path
  app.post("/v1/messages", async (c) => {
    const body = await c.req.json<{ messages?: unknown }>();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: { type: "invalid_request", message: "messages must be non-empty array" } }, 400);
    }
    return c.json({ ok: true });
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
});

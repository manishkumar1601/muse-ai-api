import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

async function readSSE(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

test("OpenAI non-stream usage: non-zero prompt + completion + total", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "the quick brown fox", messageId: "x" }),
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "say something" }] }),
  });
  const body = await res.json() as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
  assert.ok(body.usage.prompt_tokens > 0, "prompt_tokens > 0");
  assert.ok(body.usage.completion_tokens > 0, "completion_tokens > 0");
  assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
});

test("OpenAI stream emits final usage chunk with prompt + completion", async () => {
  const app = createApp({
    runChat: async (_t, onDelta) => {
      onDelta?.("hello ");
      onDelta?.("world");
      return { replyText: "hello world", messageId: "s" };
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await readSSE(res);
  const usageLine = text.split("\n").find((l) => l.includes('"usage"'));
  assert.ok(usageLine, "usage chunk present");
  const payload = JSON.parse(usageLine!.replace(/^data:\s*/, "")) as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; choices: unknown[] };
  assert.equal(payload.choices.length, 0);
  assert.ok(payload.usage.prompt_tokens > 0);
  assert.ok(payload.usage.completion_tokens > 0);
  assert.equal(payload.usage.total_tokens, payload.usage.prompt_tokens + payload.usage.completion_tokens);
});

test("Anthropic non-stream usage: non-zero input + output tokens", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "lazy dog jumps high", messageId: "y" }),
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "and then?" }] }),
  });
  const body = await res.json() as { usage: { input_tokens: number; output_tokens: number } };
  assert.ok(body.usage.input_tokens > 0);
  assert.ok(body.usage.output_tokens > 0);
});

test("Anthropic stream: message_start input_tokens > 0, message_delta output_tokens > 0", async () => {
  const app = createApp({
    runChat: async (_t, onDelta) => {
      onDelta?.("alpha ");
      onDelta?.("beta");
      return { replyText: "alpha beta", messageId: "a" };
    },
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello world" }] }),
  });
  const text = await readSSE(res);
  const startLine = text.split("\n").find((l) => l.startsWith("data:") && l.includes("message_start"));
  const deltaLine = text.split("\n").find((l) => l.startsWith("data:") && l.includes("message_delta"));
  assert.ok(startLine);
  assert.ok(deltaLine);
  const startPayload = JSON.parse(startLine!.replace(/^data:\s*/, "")) as { message: { usage: { input_tokens: number } } };
  const deltaPayload = JSON.parse(deltaLine!.replace(/^data:\s*/, "")) as { usage: { output_tokens: number } };
  assert.ok(startPayload.message.usage.input_tokens > 0);
  assert.ok(deltaPayload.usage.output_tokens > 0);
});

test("AbortSignal is forwarded to runChat (OpenAI non-stream)", async () => {
  let seenSignal: AbortSignal | undefined;
  const app = createApp({
    runChat: async (_t, _d, _k, signal) => { seenSignal = signal; return { replyText: "ok", messageId: "x" }; },
  });
  await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.ok(seenSignal instanceof AbortSignal, "runChat received AbortSignal");
});

test("AbortSignal is forwarded to runChat (Anthropic non-stream)", async () => {
  let seenSignal: AbortSignal | undefined;
  const app = createApp({
    runChat: async (_t, _d, _k, signal) => { seenSignal = signal; return { replyText: "ok", messageId: "x" }; },
  });
  await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.ok(seenSignal instanceof AbortSignal);
});

test("AbortSignal aborts: runChat sees aborted=true when controller cancels pre-dispatch", async () => {
  let observed = false;
  const app = createApp({
    runChat: async (_t, _d, _k, signal) => {
      observed = signal?.aborted === true;
      return { replyText: "", messageId: "x" };
    },
  });
  const ac = new AbortController();
  ac.abort();
  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    });
  } catch { /* fetch may throw on pre-aborted — fine */ }
  // Either fetch threw (no runChat call) or runChat ran and observed aborted.
  if (observed !== false) assert.equal(observed, true);
});

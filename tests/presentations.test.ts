import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";
import type { PresentationEvent } from "../src/hatch/chat.js";

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

const samplePres: PresentationEvent = {
  kind: "delta.presentation",
  ts_ms: 1700000000000,
  payload: { kind: "text_with_button", text: "Pick one", buttons: [{ id: "a", label: "A" }] },
};

test("OpenAI non-stream surfaces x_muse_presentations when runChat returns any", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "ok", messageId: "x", presentations: [samplePres] }),
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json() as { x_muse_presentations?: PresentationEvent[] };
  assert.ok(body.x_muse_presentations);
  assert.equal(body.x_muse_presentations!.length, 1);
  assert.equal(body.x_muse_presentations![0]!.kind, "delta.presentation");
});

test("OpenAI non-stream omits x_muse_presentations when empty", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "ok", messageId: "x", presentations: [] }),
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body["x_muse_presentations"], undefined);
});

test("OpenAI stream emits a chunk with x_muse_presentation for each event", async () => {
  const app = createApp({
    runChat: async (_t, onDelta, _k, _s, onPres) => {
      onDelta?.("hello");
      onPres?.(samplePres);
      onPres?.({ kind: "widget.state_updated", payload: { id: 42 } });
      return { replyText: "hello", messageId: "s", presentations: [samplePres] };
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await readSSE(res);
  const presLines = text.split("\n").filter((l) => l.includes("x_muse_presentation"));
  assert.equal(presLines.length, 2);
  const firstPayload = JSON.parse(presLines[0]!.replace(/^data:\s*/, "")) as { choices: unknown[]; x_muse_presentation: PresentationEvent };
  assert.equal(firstPayload.choices.length, 0);
  assert.equal(firstPayload.x_muse_presentation.kind, "delta.presentation");
});

test("Anthropic non-stream surfaces x_muse_presentations", async () => {
  const app = createApp({
    runChat: async () => ({ replyText: "ok", messageId: "x", presentations: [samplePres] }),
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json() as { x_muse_presentations?: PresentationEvent[] };
  assert.ok(body.x_muse_presentations);
  assert.equal(body.x_muse_presentations![0]!.kind, "delta.presentation");
});

test("Anthropic stream emits event: x_muse_presentation per event", async () => {
  const app = createApp({
    runChat: async (_t, onDelta, _k, _s, onPres) => {
      onDelta?.("hi");
      onPres?.(samplePres);
      return { replyText: "hi", messageId: "a", presentations: [samplePres] };
    },
  });
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await readSSE(res);
  assert.ok(text.includes("event: x_muse_presentation"), "x_muse_presentation event emitted");
  const idx = text.indexOf("event: x_muse_presentation");
  const dataLine = text.slice(idx).split("\n").find((l) => l.startsWith("data:"))!;
  const payload = JSON.parse(dataLine.replace(/^data:\s*/, "")) as PresentationEvent;
  assert.equal(payload.kind, "delta.presentation");
});

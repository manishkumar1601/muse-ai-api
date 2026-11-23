import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";
import { loadConfig } from "../src/config.js";
import { SessionStore, deriveSessionKey } from "../src/hatch/sessions.js";
import { createClientPool } from "../src/hatch/pool.js";
import { MuseChatTimeoutError } from "../src/hatch/chat.js";
import type { HatchClient } from "../src/hatch/client.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function okApp(capture?: { text?: string | undefined; key?: string | undefined }) {
  return createApp({
    runChat: async (text, _d, key) => {
      if (capture) { capture.text = text; capture.key = key; }
      return { replyText: "ok reply", messageId: "m1" };
    },
  });
}

test("QA: null JSON body -> 400, not 500 (OpenAI)", async () => {
  const res = await okApp().request("/v1/chat/completions", { method: "POST", headers: JSON_HEADERS, body: "null" });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { type: string } };
  assert.equal(body.error.type, "invalid_request_error");
});

test("QA: messages as a string -> 400, not 500 (OpenAI)", async () => {
  const res = await okApp().request("/v1/chat/completions", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages: "hi" }) });
  assert.equal(res.status, 400);
});

test("QA: numeric message content -> 400, not 500 (Anthropic envelope)", async () => {
  const res = await okApp().request("/v1/messages", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages: [{ role: "user", content: 123 }] }) });
  assert.equal(res.status, 400);
  const body = await res.json() as { type: string; error: { type: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
});

test("QA: assistant tool-call message with content:null does not crash", async () => {
  const capture: { text?: string | undefined } = {};
  const res = await okApp(capture).request("/v1/chat/completions", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ messages: [
      { role: "assistant", content: null },
      { role: "user", content: "hello there" },
    ] }),
  });
  assert.equal(res.status, 200);
  assert.ok(capture.text?.includes("hello there"));
});

test("QA: Anthropic system as an array of blocks is forwarded, not dropped", async () => {
  const capture: { text?: string | undefined } = {};
  const res = await okApp(capture).request("/v1/messages", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({
      system: [{ type: "text", text: "Be terse." }],
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.ok(capture.text?.includes("Be terse."), `system text missing from prompt: ${capture.text}`);
});

test("QA: count_tokens with no messages -> 400, not {input_tokens:1}", async () => {
  const res = await okApp().request("/v1/messages/count_tokens", { method: "POST", headers: JSON_HEADERS, body: "{}" });
  assert.equal(res.status, 400);
});

test("QA: count_tokens counts array-form system like /v1/messages does", async () => {
  const app = okApp();
  const payload = {
    system: [{ type: "text", text: "Be terse and precise in every answer you give" }],
    messages: [{ role: "user", content: "hello world this is a longer message" }],
  };
  const counted = await app.request("/v1/messages/count_tokens", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });
  assert.equal(counted.status, 200);
  const { input_tokens } = await counted.json() as { input_tokens: number };
  const noSystem = await app.request("/v1/messages/count_tokens", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages: payload.messages }) });
  const { input_tokens: without } = await noSystem.json() as { input_tokens: number };
  assert.ok(input_tokens > without, `system not counted: ${input_tokens} vs ${without}`);
});

test("QA: auth failure shapes are protocol-correct", async () => {
  const app = createApp({
    cfg: { ...loadConfig({}), proxyKey: "secret" },
    runChat: async () => ({ replyText: "x", messageId: "m" }),
  });
  const oai = await app.request("/v1/models", { headers: {} });
  assert.equal(oai.status, 401);
  assert.equal(((await oai.json()) as { error: { type: string } }).error.type, "authentication_error");
  const ant = await app.request("/v1/messages", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(ant.status, 401);
  const ab = await ant.json() as { type: string; error: { type: string } };
  assert.equal(ab.type, "error");
  assert.equal(ab.error.type, "authentication_error");
});

test("QA: x-api-key derives distinct sessions for Anthropic clients", async () => {
  const keys: string[] = [];
  const app = createApp({
    runChat: async (_t, _d, key) => { keys.push(key ?? ""); return { replyText: "x", messageId: "m" }; },
  });
  const call = (k: string) => app.request("/v1/messages", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-api-key": k },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  await call("key-one");
  await call("key-two");
  await call("key-one");
  assert.ok(keys[0] && keys[0] !== "default");
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
});

test("QA: OpenAI stream error is not masked as finish_reason stop", async () => {
  const app = createApp({ runChat: async () => { throw new Error("upstream exploded"); } });
  const res = await app.request("/v1/chat/completions", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();
  assert.ok(text.includes('"error"'), "error chunk present");
  assert.ok(!text.includes('"finish_reason":"stop"'), "no success stop chunk after error");
});

test("QA: Anthropic stream error arrives as an error event, not assistant text", async () => {
  const app = createApp({ runChat: async () => { throw new Error("upstream exploded"); } });
  const res = await app.request("/v1/messages", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();
  assert.ok(text.includes("event: error"), "SSE error event present");
  assert.ok(!text.includes("[proxy error"), "error not injected as text");
  assert.ok(!text.includes('"type":"message_stop"'), "no message_stop after error");
});

test("QA: unknown route returns a JSON error, not plain text", async () => {
  const res = await okApp().request("/nope");
  assert.equal(res.status, 404);
  const body = await res.json() as { error: { type: string } };
  assert.ok(body.error.type.length > 0);
});

test("QA: SessionStore expires the accessed key itself after TTL", async () => {
  const s = new SessionStore(10, 100);
  const first = s.get("k").sessionId;
  await new Promise((r) => setTimeout(r, 25));
  const second = s.get("k").sessionId;
  assert.notEqual(first, second);
});

test("QA: deriveSessionKey uses x-api-key when no Authorization header", () => {
  const k = deriveSessionKey({ xApiKey: "some-key" });
  assert.ok(k.startsWith("a:"));
  assert.notEqual(k, deriveSessionKey({ xApiKey: "other-key" }));
});

test("QA: pool keeps the shared client alive after a chat timeout", async () => {
  let closed = false;
  const client = { close: async () => { closed = true; } } as unknown as HatchClient;
  const pool = createClientPool({ openClient: async () => client });
  await assert.rejects(pool.withClient(async () => { throw new MuseChatTimeoutError("Timed out"); }));
  assert.equal(closed, false);
  assert.strictEqual(pool.peek(), client);
});

test("QA: config rejects out-of-range port and treats empty key as unset", () => {
  assert.throws(() => loadConfig({ MUSE_PROXY_PORT: "99999" }));
  assert.equal(loadConfig({ MUSE_PROXY_KEY: "   " }).proxyKey, undefined);
  assert.equal(loadConfig({ MUSE_PROXY_KEY: " k " }).proxyKey, "k");
});

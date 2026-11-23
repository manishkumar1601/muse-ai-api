import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";
import { loadConfig } from "../src/config.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function okApp(capture?: { text?: string | undefined }) {
  return createApp({
    runChat: async (text, onDelta) => {
      if (capture) capture.text = text;
      onDelta?.("Hello ");
      onDelta?.("world");
      return { replyText: "Hello world", messageId: "m42" };
    },
  });
}

test("POST /v1/responses non-stream returns a completed response object", async () => {
  const res = await okApp().request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ model: "muse-spark", input: "say hello" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    id: string; object: string; status: string; output_text: string;
    output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  };
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.id, "resp_m42");
  assert.equal(body.output_text, "Hello world");
  assert.equal(body.output[0]?.type, "message");
  assert.equal(body.output[0]?.content[0]?.text, "Hello world");
  assert.ok(body.usage.input_tokens > 0 && body.usage.output_tokens > 0);
  assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens);
});

test("POST /v1/responses: instructions + message items are flattened (incl. tool output)", async () => {
  const capture: { text?: string | undefined } = {};
  const res = await okApp(capture).request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({
      instructions: "You are a coding agent.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
        { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}", call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "file1.ts file2.ts" },
        { type: "reasoning", summary: [] },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.ok(capture.text?.includes("You are a coding agent."), "instructions forwarded");
  assert.ok(capture.text?.includes("fix the bug"), "user text forwarded");
  assert.ok(capture.text?.includes("called tool shell"), "function_call summarised");
  assert.ok(capture.text?.includes("file1.ts file2.ts"), "tool output forwarded");
});

test("POST /v1/responses validation: missing/empty/wrong-type input -> 400", async () => {
  const app = okApp();
  for (const payload of [{}, { input: 123 }, { input: [] }, { input: "   " }, null]) {
    const res = await app.request("/v1/responses", {
      method: "POST", headers: JSON_HEADERS,
      body: payload === null ? "null" : JSON.stringify(payload),
    });
    assert.equal(res.status, 400, `payload ${JSON.stringify(payload)}`);
    const body = await res.json() as { error: { type: string } };
    assert.equal(body.error.type, "invalid_request_error");
  }
});

test("POST /v1/responses stream emits the Responses event sequence", async () => {
  const res = await okApp().request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ stream: true, input: "hi" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const ev of ["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.done", "response.output_item.done", "response.completed"]) {
    assert.ok(text.includes(`event: ${ev}`), `missing ${ev}`);
  }
  assert.ok(!text.includes("response.failed"));
  const deltas = [...text.matchAll(/"delta":"([^"]*)"/g)].map((m) => m[1]).join("");
  assert.equal(deltas, "Hello world");
  const completed = text.split("\n").find((l) => l.startsWith("data:") && l.includes("response.completed"));
  assert.ok(completed && completed.includes('"output_text":"Hello world"'));
});

test("POST /v1/responses stream failure emits response.failed, not completed", async () => {
  const app = createApp({ runChat: async () => { throw new Error("upstream down"); } });
  const res = await app.request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ stream: true, input: "hi" }),
  });
  const text = await res.text();
  assert.ok(text.includes("event: response.failed"));
  assert.ok(text.includes("upstream down"));
  assert.ok(!text.includes("event: response.completed"));
});

test("POST /v1/responses non-stream upstream failure maps status + shape", async () => {
  const app = createApp({ runChat: async () => { throw new Error("bootstrap failed: nope"); } });
  const res = await app.request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(res.status, 502);
  const body = await res.json() as { error: { type: string } };
  assert.equal(body.error.type, "server_error");
});

test("POST /v1/responses requires auth when a proxy key is set", async () => {
  const app = createApp({
    cfg: { ...loadConfig({}), proxyKey: "secret" },
    runChat: async () => ({ replyText: "x", messageId: "m" }),
  });
  const res = await app.request("/v1/responses", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(res.status, 401);
});

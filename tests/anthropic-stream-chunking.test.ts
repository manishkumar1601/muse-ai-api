import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

test("/v1/messages stream emits full text across many deltas when runChat pushes chunks", async () => {
  const full = 'Project = "Free Medium". Chrome extension. Bypasses Medium paywall.\n\n' +
    "What it does:\n- Detects article page.\n- Injects button.\n- Routes through freedium.cfd.\n\n" +
    "x".repeat(1500);

  const app = createApp({
    runChat: async (_t, onDelta) => {
      for (let i = 0; i < full.length; i += 300) {
        onDelta?.(full.slice(i, i + 300));
        await new Promise((r) => setTimeout(r, 1));
      }
      return { replyText: full, messageId: "test" };
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const sse = await res.text();

  // Extract all text_delta values from the SSE stream.
  const matches = [...sse.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)];
  assert.ok(matches.length >= 2, `expected multiple deltas, got ${matches.length}`);

  const assembled = matches
    .map((m) => JSON.parse(`"${m[1]}"`) as string)
    .join("");
  assert.equal(assembled, full, "re-assembled SSE text must equal original");
  assert.ok(sse.includes("message_stop"), "must emit message_stop");
});

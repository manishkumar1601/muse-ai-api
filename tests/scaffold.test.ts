import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server/start.js";

test("GET /healthz returns 200 ok", async () => {
  const res = await createApp().request("/healthz");
  assert.equal(res.status, 200);
  const body = await res.json() as unknown;
  assert.deepEqual(body, { ok: true });
});

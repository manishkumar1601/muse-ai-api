import { test } from "node:test";
import assert from "node:assert/strict";
import { HatchClient } from "../src/hatch/client.js";

test("HatchClient — module exports are present", async () => {
  // Smoke test: import works without crashing.
  assert.equal(typeof HatchClient.open, "function");
});

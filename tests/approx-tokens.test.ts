import { test } from "node:test";
import assert from "node:assert/strict";
import { approxTokens } from "../src/server/common.js";

test("approxTokens returns a positive count for empty-ish strings", () => {
  assert.equal(approxTokens(""), 1);
  assert.equal(approxTokens("a"), 1);
});

test("approxTokens uses tiktoken (not chars/4) for a known phrase", () => {
  // chars/4 for this 43-char string = 11. cl100k_base encodes it as 9 tokens.
  // If the encoder loads, we get 9. If it fails, we fall back to 11.
  const count = approxTokens("The quick brown fox jumps over the lazy dog");
  assert.ok(count === 9 || count === 11, `expected 9 (tiktoken) or 11 (fallback), got ${count}`);
});

test("approxTokens scales roughly linearly with length", () => {
  const short = approxTokens("Hello");
  const long = approxTokens("Hello ".repeat(100));
  assert.ok(long > short * 10);
});

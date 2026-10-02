import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHROME_UA,
  CHROME_SEC_CH_UA,
  CHROME_SEC_CH_UA_PLATFORM,
  SHARED_HEADERS,
  CHROME_JA3,
} from "../src/hatch/tls.js";

test("Chrome header constants are correctly set", () => {
  assert.ok(CHROME_UA.includes("Chrome/154"));
  assert.ok(CHROME_UA.includes("Windows NT 10.0"));
  assert.equal(CHROME_SEC_CH_UA_PLATFORM, '"Windows"');
  assert.ok(CHROME_SEC_CH_UA.includes('"154"'));
  assert.equal(SHARED_HEADERS["User-Agent"], CHROME_UA);
  assert.equal(SHARED_HEADERS["sec-ch-ua-platform"], CHROME_SEC_CH_UA_PLATFORM);
  assert.equal(SHARED_HEADERS["Origin"], "https://muse.ai");
  assert.ok(CHROME_JA3.startsWith("771,"));
});

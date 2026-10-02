import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeVmFromHtml } from "../src/bootstrap/scrape-vm.js";
import { loadCookies, toCookieHeader } from "../src/bootstrap/cookies.js";

test("scrapeVmFromHtml extracts UUID from activeGatewayUrl", () => {
  const html = `blah "activeGatewayUrl":"wss://3574599d-879f-4ffe-b294-61b50ba60c1a.metaaivm.com/" blah`;
  const r = scrapeVmFromHtml(html);
  assert.deepEqual(r, {
    vmId: "3574599d-879f-4ffe-b294-61b50ba60c1a",
    gatewayUrl: "wss://3574599d-879f-4ffe-b294-61b50ba60c1a.metaaivm.com/",
  });
});

test("scrapeVmFromHtml returns null when absent", () => {
  assert.equal(scrapeVmFromHtml("<html/>"), null);
});

test("loadCookies filters to muse.ai cookies only", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-test-"));
  const file = join(dir, "storage_state.json");
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        { name: "hatch_sess", value: "abc", domain: "muse.ai" },
        { name: "other_sess", value: "xyz", domain: ".muse.ai" },
        { name: "unrelated", value: "123", domain: "example.com" },
      ],
    }),
    "utf-8",
  );
  const cookies = loadCookies(file);
  assert.deepEqual(Object.keys(cookies).sort(), ["hatch_sess", "other_sess"]);
  assert.equal(cookies["hatch_sess"], "abc");
  assert.equal(cookies["other_sess"], "xyz");
  assert.equal(cookies["unrelated"], undefined);
});

test("toCookieHeader joins key=value pairs", () => {
  assert.equal(toCookieHeader({ a: "1", b: "2" }), "a=1; b=2");
});

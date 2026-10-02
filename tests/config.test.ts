import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig picks up defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.model, "muse-spark");
  assert.equal(cfg.timezone, "Asia/Calcutta");
  assert.equal(cfg.proxyKey, undefined);
});

test("loadConfig honors env overrides", () => {
  const cfg = loadConfig({ MUSE_PROXY_PORT: "9999", MUSE_PROXY_KEY: "k" });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.proxyKey, "k");
});

test("loadConfig rejects non-numeric port", () => {
  assert.throws(() => loadConfig({ MUSE_PROXY_PORT: "notanum" }), /MUSE_PROXY_PORT/);
});

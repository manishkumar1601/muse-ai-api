import { existsSync } from "node:fs";
import { loadConfig } from "./src/config.js";
import { start } from "./src/server/start.js";

// Load a local .env if one exists (Node 22+). Shell exports win:
// loadEnvFile does not overwrite variables already set.
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch { /* a malformed .env should not stop the proxy */ }

let stop: () => Promise<void>;
try {
  const cfg = loadConfig();
  stop = await start(cfg);
} catch (e) {
  // Zod config errors: report the first issue as one readable line
  // (e.g. "MUSE_PROXY_PORT: Number must be less than or equal to 65535").
  const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  const first = issues?.[0];
  const detail = first
    ? `${first.path.join(".") || "config"}: ${first.message}`
    : (e instanceof Error ? e.message : String(e)).split("\n")[0];
  console.error(`muse-proxy: failed to start — ${detail}`);
  console.error("Check your environment (see .env.example) and try again.");
  process.exit(1);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    // Never hang forever on shutdown: give cleanup 5s, then exit anyway.
    setTimeout(() => process.exit(0), 5000).unref();
    void stop().finally(() => process.exit(0));
  });
}

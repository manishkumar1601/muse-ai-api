import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { bootstrap } from "../bootstrap/session.js";
import { shutdownTls } from "../hatch/tls.js";
import { logger } from "../log.js";

try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch { /* ignore malformed .env */ }

// Optional flags (see docs/troubleshooting.md):
//   npm run bootstrap -- --vm-id <id> --gateway-url <wss://…>
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
if (process.argv.includes("--help")) {
  console.log("Usage: npm run bootstrap [-- --vm-id <id> --gateway-url <url>]");
  process.exit(0);
}
const vmId = argValue("--vm-id");
const gatewayUrl = argValue("--gateway-url");

const cfg = loadConfig();
try {
  const s = await bootstrap({
    storageStatePath: cfg.storageStatePath,
    sessionPath: cfg.sessionPath,
    ...(vmId ? { vmId } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
  });
  logger.info({ vm_id: s.vm_id, out: cfg.sessionPath }, "bootstrap OK");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  logger.error({ err: msg }, "bootstrap failed");
  process.exitCode = 1;
} finally {
  await shutdownTls();
}

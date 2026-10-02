import { loadConfig } from "../config.js";
import { bootstrap } from "../bootstrap/session.js";
import { shutdownTls } from "../hatch/tls.js";
import { logger } from "../log.js";

const cfg = loadConfig();
try {
  const s = await bootstrap({ storageStatePath: cfg.storageStatePath, sessionPath: cfg.sessionPath });
  logger.info({ vm_id: s.vm_id, out: cfg.sessionPath }, "bootstrap OK");
} catch (e) {
  logger.error({ err: (e as Error).message }, "bootstrap failed");
  process.exitCode = 1;
} finally {
  await shutdownTls();
}

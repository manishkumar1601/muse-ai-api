import { start } from "./src/server/start.js";
const stop = await start(process.env["MUSE_PROXY_HOST"] ?? "127.0.0.1",
                          Number(process.env["MUSE_PROXY_PORT"] ?? 8787));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => { await stop(); process.exit(0); });
}

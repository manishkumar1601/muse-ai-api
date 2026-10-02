import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "../log.js";
import type { Config } from "../config.js";
import { logRequest } from "./middleware.js";

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", logRequest);
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}

export async function start(cfg: Config): Promise<() => Promise<void>> {
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
  logger.info({ host: cfg.host, port: cfg.port }, "listening");
  return () => new Promise((resolve) => server.close(() => resolve()));
}

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "../log.js";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}

export async function start(host: string, port: number): Promise<() => Promise<void>> {
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: host, port });
  logger.info({ host, port }, "listening");
  return () => new Promise((resolve) => server.close(() => resolve()));
}

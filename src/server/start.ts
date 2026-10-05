import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "../log.js";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { logRequest } from "./middleware.js";
import { registerOpenAI } from "./openai.js";
import { registerAnthropic } from "./anthropic.js";
import { runChat as realRunChat } from "./handler.js";

export interface AppDeps {
  cfg?: Config;
  runChat?: (userText: string, onDelta?: (c: string) => void, sessionKey?: string) => Promise<{ replyText: string; messageId: string }>;
}

export function createApp(deps?: AppDeps): Hono {
  const cfg = deps?.cfg ?? loadConfig();
  const runChat = deps?.runChat ?? ((userText: string, onDelta?: (c: string) => void, sessionKey?: string) => realRunChat(cfg, userText, onDelta, sessionKey));
  const app = new Hono();
  app.use("*", logRequest);
  app.get("/healthz", (c) => c.json({ ok: true }));
  registerOpenAI(app, { cfg, runChat });
  registerAnthropic(app, { cfg, runChat });
  return app;
}

export async function start(cfg: Config): Promise<() => Promise<void>> {
  const app = createApp({ cfg });
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
  logger.info({ host: cfg.host, port: cfg.port }, "listening");
  return () => new Promise((resolve) => server.close(() => resolve()));
}

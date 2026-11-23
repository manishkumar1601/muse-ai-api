import { existsSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { logger } from "../log.js";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { logRequest } from "./middleware.js";
import { registerOpenAI } from "./openai.js";
import { registerResponses } from "./responses.js";
import { registerAnthropic } from "./anthropic.js";
import { runChat as realRunChat, resetPool } from "./handler.js";
import { anthropicError, openaiError } from "./errors.js";
import type { PresentationEvent } from "../hatch/chat.js";

export interface AppDeps {
  cfg?: Config;
  runChat?: (
    userText: string,
    onDelta?: (c: string) => void,
    sessionKey?: string,
    signal?: AbortSignal,
    onPresentation?: (p: PresentationEvent) => void,
  ) => Promise<{ replyText: string; messageId: string; presentations?: PresentationEvent[] }>;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function isAnthropicPath(path: string): boolean {
  return path.startsWith("/v1/messages");
}

export function createApp(deps?: AppDeps): Hono {
  const cfg = deps?.cfg ?? loadConfig();
  const runChat = deps?.runChat ?? ((userText: string, onDelta?: (c: string) => void, sessionKey?: string, signal?: AbortSignal, onPresentation?: (p: PresentationEvent) => void) => realRunChat(cfg, userText, onDelta, sessionKey, signal, onPresentation));
  const app = new Hono();
  app.use("*", logRequest);
  app.use("*", bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => isAnthropicPath(c.req.path)
      ? anthropicError(c, 413, "invalid_request_error", `request body too large (max ${MAX_BODY_BYTES} bytes)`)
      : openaiError(c, 413, "invalid_request_error", `request body too large (max ${MAX_BODY_BYTES} bytes)`),
  }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  registerOpenAI(app, { cfg, runChat });
  registerResponses(app, { cfg, runChat });
  registerAnthropic(app, { cfg, runChat });
  app.notFound((c) => isAnthropicPath(c.req.path)
    ? anthropicError(c, 404, "not_found_error", "not found")
    : openaiError(c, 404, "invalid_request_error", "not found"));
  app.onError((err, c) => {
    logger.error({ err: err.message, path: c.req.path }, "unhandled error");
    return isAnthropicPath(c.req.path)
      ? anthropicError(c, 500, "api_error", "internal error")
      : openaiError(c, 500, "server_error", "internal error");
  });
  return app;
}

export async function start(cfg: Config): Promise<() => Promise<void>> {
  if (!existsSync(cfg.storageStatePath) || !existsSync(cfg.sessionPath)) {
    logger.warn(
      { storageStatePath: cfg.storageStatePath, sessionPath: cfg.sessionPath },
      "session files missing — chat calls will fail until you run `npm run login`",
    );
  }
  const app = createApp({ cfg });
  const server = serve(
    { fetch: app.fetch, hostname: cfg.host, port: cfg.port },
    () => { logger.info({ host: cfg.host, port: cfg.port }, "listening"); },
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.fatal({ host: cfg.host, port: cfg.port }, `port ${cfg.port} is already in use — is another copy of the proxy running?`);
    } else {
      logger.fatal({ err: err.message }, "server error");
    }
    process.exit(1);
  });
  return async () => {
    await resetPool().catch(() => {});
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // SSE streams are long-lived connections; force them closed so
      // shutdown does not hang waiting for an in-flight stream.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  };
}

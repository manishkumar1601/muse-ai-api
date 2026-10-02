import type { MiddlewareHandler } from "hono";
import { logger } from "../log.js";

export const logRequest: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  logger.info({ method: c.req.method, path: c.req.path }, "req");
  await next();
  logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "resp");
};

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { anthropicError, openaiError } from "./errors.js";

function hashEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function requireAuth(
  c: Context,
  key: string | undefined,
  protocol: "openai" | "anthropic" = "openai",
): Response | undefined {
  if (!key) return undefined;
  const auth = c.req.header("authorization");
  const presented = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : c.req.header("x-api-key")?.trim();
  if (!presented || !hashEq(presented, key.trim())) {
    return protocol === "anthropic"
      ? anthropicError(c, 401, "authentication_error", "invalid api key")
      : openaiError(c, 401, "authentication_error", "invalid api key");
  }
  return undefined;
}

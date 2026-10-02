import type { Context } from "hono";

export function requireAuth(c: Context, key: string | undefined): Response | undefined {
  if (!key) return undefined;
  const auth = c.req.header("authorization");
  const presented = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : c.req.header("x-api-key")?.trim();
  if (presented !== key) {
    return c.json({ error: { type: "auth", message: "invalid api key" } }, 401);
  }
  return undefined;
}

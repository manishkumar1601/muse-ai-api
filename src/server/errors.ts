import type { Context } from "hono";

// Protocol-correct error envelopes.
// OpenAI:    { error: { type, message } } with types like invalid_request_error.
// Anthropic: { type: "error", error: { type, message } }.
export function openaiError(c: Context, status: number, type: string, message: string): Response {
  return c.json({ error: { type, message } }, status as never);
}

export function anthropicError(c: Context, status: number, type: string, message: string): Response {
  return c.json({ type: "error", error: { type, message } }, status as never);
}

// Map an upstream (Hatch/bootstrap) failure to an HTTP status.
// Timeouts are 504 (SDKs retry 503 aggressively, which can re-send the
// user's message upstream); bootstrap failures are 502; the rest stay 503.
export function upstreamStatus(e: unknown): number {
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "MuseChatTimeoutError" || /timed out/i.test(msg)) return 504;
  if (/bootstrap failed/i.test(msg)) return 502;
  return 503;
}

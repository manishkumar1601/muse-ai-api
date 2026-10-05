import type { Context } from "hono";
import { deriveSessionKey } from "../hatch/sessions.js";

interface ContentBlock { type: string; text?: string; }
export interface ChatMessage { role: string; content: string | ContentBlock[]; }

export function sessionKeyFromReq(c: Context): string {
  return deriveSessionKey({
    xMuseSession: c.req.header("x-muse-session"),
    authorization: c.req.header("authorization"),
  });
}

export function flattenMessages(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : m.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    if (!text.trim()) continue;
    if (m.role === "system") out.push(`[system]\n${text}`);
    else if (m.role === "assistant") out.push(`[assistant previous turn]\n${text}`);
    else out.push(text);
  }
  return out.join("\n\n");
}

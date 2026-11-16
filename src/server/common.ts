import type { Context } from "hono";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { deriveSessionKey } from "../hatch/sessions.js";

interface ContentBlock { type: string; text?: string; }
export interface ChatMessage { role: string; content: string | ContentBlock[]; }

export function sessionKeyFromReq(c: Context): string {
  return deriveSessionKey({
    xMuseSession: c.req.header("x-muse-session"),
    authorization: c.req.header("authorization"),
  });
}

// cl100k_base = GPT-4 / GPT-3.5-turbo encoder. Close-enough approximation for
// Claude as well; still better than chars/4. Lazy-init + chars/4 fallback if
// the encoder fails to load (keeps the proxy alive on exotic platforms).
let enc: Tiktoken | null = null;
let encTried = false;
export function approxTokens(s: string): number {
  if (!s) return 1;
  if (!encTried) {
    encTried = true;
    try { enc = getEncoding("cl100k_base"); } catch { enc = null; }
  }
  if (enc !== null) {
    try { return Math.max(1, enc.encode(s).length); } catch { /* fall through to heuristic */ }
  }
  return Math.max(1, Math.ceil(s.length / 4));
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

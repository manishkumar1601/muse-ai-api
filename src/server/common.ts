import type { Context } from "hono";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { deriveSessionKey } from "../hatch/sessions.js";

export interface ContentBlock { type: string; text?: string; }
export interface ChatMessage { role: string; content: string | ContentBlock[] | null; }

export function sessionKeyFromReq(c: Context): string {
  const hdr = (name: string): string | undefined => c.req.header(name);
  return deriveSessionKey({
    xMuseSession: hdr("x-muse-session"),
    authorization: hdr("authorization"),
    xApiKey: hdr("x-api-key"),
  });
}

// Normalise an Anthropic `system` field (string OR array of text blocks)
// to a plain string. Returns "" for anything else.
export function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b): b is ContentBlock => typeof b === "object" && b !== null && (b as ContentBlock).type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

// Validate a parsed JSON chat body. Returns an error message, or null if OK.
// A body that is valid JSON but the wrong shape must be a 400, never a 500.
export function validateChatBody(body: unknown, opts?: { requireMessages?: boolean }): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const messages = (body as { messages?: unknown }).messages;
  if (messages === undefined) {
    return opts?.requireMessages ? "messages is required" : null;
  }
  if (!Array.isArray(messages)) return "messages must be an array";
  for (const m of messages) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) return "each message must be an object";
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== undefined && typeof msg.role !== "string") return "message role must be a string";
    const content = msg.content;
    if (content !== undefined && content !== null && typeof content !== "string" && !Array.isArray(content)) {
      return "message content must be a string, an array of blocks, or null";
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b !== "object" || b === null) return "message content blocks must be objects";
      }
    }
  }
  return null;
}

// cl100k_base = GPT-4 / GPT-3.5-turbo encoder. Close-enough approximation for
// Claude as well; still better than chars/4. Lazy-init + chars/4 fallback if
// the encoder fails to load (keeps the proxy alive on exotic platforms).
let enc: Tiktoken | null = null;
let encTried = false;
export function approxTokens(s: string): number {
  if (!s) return 0;
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
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const content: unknown = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b): b is ContentBlock => typeof b === "object" && b !== null && (b as ContentBlock).type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("");
    }
    // content: null (e.g. OpenAI assistant tool-call messages) -> no text.
    if (!text.trim()) continue;
    if (m.role === "system") out.push(`[system]\n${text}`);
    else if (m.role === "assistant") out.push(`[assistant previous turn]\n${text}`);
    else out.push(text);
  }
  return out.join("\n\n");
}

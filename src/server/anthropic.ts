import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { approxTokens, flattenMessages, sessionKeyFromReq } from "./common.js";
import type { ChatMessage } from "./common.js";
import type { PresentationEvent } from "../hatch/chat.js";

const DEBUG = process.env["PROXY_DEBUG"] === "1";
const dbg = (tag: string, data: unknown): void => {
  if (!DEBUG) return;
  try { appendFileSync("proxy-debug.log", `[${new Date().toISOString()}] ${tag}: ${JSON.stringify(data)}\n`); } catch { /* best-effort */ }
};

export interface AnthropicDeps {
  cfg: Config;
  runChat(
    userText: string,
    onDelta?: (chunk: string) => void,
    sessionKey?: string,
    signal?: AbortSignal,
    onPresentation?: (p: PresentationEvent) => void,
  ): Promise<{ replyText: string; messageId: string; presentations?: PresentationEvent[] }>;
}

export function registerAnthropic(app: Hono, deps: AnthropicDeps): void {
  const { cfg } = deps;

  app.post("/v1/messages/count_tokens", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey);
    if (deny) return deny;

    let body: { messages?: ChatMessage[]; system?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "invalid_request", message: "invalid JSON body" } }, 400);
    }

    const parts: string[] = [];
    for (const m of body.messages ?? []) {
      if (typeof m.content === "string") parts.push(m.content);
      else for (const b of m.content) if (b.text) parts.push(b.text);
    }
    if (typeof body.system === "string") parts.push(body.system);

    return c.json({ input_tokens: approxTokens(parts.join("\n")) });
  });

  app.post("/v1/messages", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey);
    if (deny) return deny;

    let body: { model?: string; messages?: ChatMessage[]; system?: string; stream?: boolean; max_tokens?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "invalid_request", message: "invalid JSON body" } }, 400);
    }

    const messages: ChatMessage[] = body.messages ?? [];
    if (typeof body.system === "string" && body.system.length > 0) {
      messages.unshift({ role: "system", content: body.system });
    }

    const userText = flattenMessages(messages);
    if (!userText.trim()) {
      return c.json({ error: { type: "invalid_request", message: "no non-empty user message" } }, 400);
    }

    const model = body.model ?? cfg.model;
    const stream = body.stream === true;
    const sKey = sessionKeyFromReq(c);

    if (!stream) {
      let r: { replyText: string; messageId: string; presentations?: PresentationEvent[] };
      try {
        r = await deps.runChat(userText, undefined, sKey, c.req.raw.signal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: { type: "service_unavailable", message: msg } }, 503);
      }
      const it = approxTokens(userText);
      const ot = approxTokens(r.replyText);
      const pres = r.presentations ?? [];
      return c.json({
        id: `msg_${r.messageId}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: r.replyText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: it, output_tokens: ot },
        ...(pres.length > 0 ? { x_muse_presentations: pres } : {}),
      });
    }

    return streamSSE(c, async (s) => {
      const msgId = `msg_${randomUUID()}`;

      const inputTokens = approxTokens(userText);
      await s.writeSSE({ event: "message_start", data: JSON.stringify({
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
      }) });

      await s.writeSSE({ event: "content_block_start", data: JSON.stringify({
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      }) });

      type QItem = { t: "text"; v: string } | { t: "pres"; v: PresentationEvent };
      const queue: QItem[] = [];
      let done = false;
      let onPush: (() => void) | null = null;
      const push = (t: string) => { queue.push({ t: "text", v: t }); onPush?.(); };
      const pushPres = (p: PresentationEvent) => { queue.push({ t: "pres", v: p }); onPush?.(); };
      let runError: Error | null = null;
      let finalReplyText = "";
      const run = deps.runChat(userText, push, sKey, c.req.raw.signal, pushPres)
        .then((result) => { finalReplyText = result.replyText; })
        .catch((e: unknown) => { runError = e instanceof Error ? e : new Error(String(e)); })
        .finally(() => { done = true; onPush?.(); });

      let outputTokens = 0;
      let totalLen = 0;
      let chunkCount = 0;
      let streamedText = "";
      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.t === "pres") {
            await s.writeSSE({ event: "x_muse_presentation", data: JSON.stringify(item.v) });
            continue;
          }
          const chunk = item.v;
          streamedText += chunk;
          outputTokens += approxTokens(chunk);
          totalLen += chunk.length;
          chunkCount++;
          dbg("delta", { len: chunk.length, preview: chunk.slice(0, 60) });
          await s.writeSSE({ event: "content_block_delta", data: JSON.stringify({
            type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk },
          }) });
        }
        if (!done) {
          await new Promise<void>((resolve) => {
            onPush = () => { onPush = null; resolve(); };
            if (done || queue.length > 0) onPush?.();
          });
        }
      }
      await run;
      if (finalReplyText.startsWith(streamedText)) {
        const suffix = finalReplyText.slice(streamedText.length);
        if (suffix) {
          outputTokens += approxTokens(suffix);
          totalLen += suffix.length;
          chunkCount++;
          await s.writeSSE({ event: "content_block_delta", data: JSON.stringify({
            type: "content_block_delta", index: 0, delta: { type: "text_delta", text: suffix },
          }) });
        }
      }
      if (runError !== null) {
        const errMsg = (runError as Error).message;
        await s.writeSSE({ event: "content_block_delta", data: JSON.stringify({
          type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: `\n[proxy error: ${errMsg}]` },
        }) });
      }

      await s.writeSSE({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) });
      await s.writeSSE({ event: "message_delta", data: JSON.stringify({
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens },
      }) });
      await s.writeSSE({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
      dbg("done", { totalLen, chunkCount, err: runError !== null ? (runError as Error).message : null });
    });
  });
}

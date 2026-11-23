import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { approxTokens, flattenMessages, sessionKeyFromReq, systemText, validateChatBody } from "./common.js";
import { anthropicError, upstreamStatus } from "./errors.js";
import { logger } from "../log.js";
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
    const deny = requireAuth(c, cfg.proxyKey, "anthropic");
    if (deny) return deny;

    let body: { messages?: ChatMessage[]; system?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return anthropicError(c, 400, "invalid_request_error", "invalid JSON body");
    }

    const invalid = validateChatBody(body, { requireMessages: true });
    if (invalid) return anthropicError(c, 400, "invalid_request_error", invalid);

    // Count exactly what /v1/messages would send: same system handling,
    // same flattenMessages markers and joins.
    const messages: ChatMessage[] = [...(body.messages ?? [])];
    const sys = systemText(body.system);
    if (sys.length > 0) messages.unshift({ role: "system", content: sys });

    return c.json({ input_tokens: approxTokens(flattenMessages(messages)) });
  });

  app.post("/v1/messages", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey, "anthropic");
    if (deny) return deny;

    let body: { model?: string; messages?: ChatMessage[]; system?: unknown; stream?: boolean; max_tokens?: number };
    try {
      body = await c.req.json();
    } catch {
      return anthropicError(c, 400, "invalid_request_error", "invalid JSON body");
    }

    const invalid = validateChatBody(body);
    if (invalid) return anthropicError(c, 400, "invalid_request_error", invalid);

    const messages: ChatMessage[] = [...(body.messages ?? [])];
    const sys = systemText(body.system);
    if (sys.length > 0) {
      messages.unshift({ role: "system", content: sys });
    }

    const userText = flattenMessages(messages);
    if (!userText.trim()) {
      return anthropicError(c, 400, "invalid_request_error", "no non-empty user message");
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
        return anthropicError(c, upstreamStatus(e), "api_error", msg);
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
      if (runError !== null) {
        // Protocol error event — never inject the error as assistant text,
        // and do not follow it with end_turn / message_stop success events.
        const errMsg = (runError as Error).message;
        logger.warn({ err: errMsg }, "anthropic stream: runChat error");
        await s.writeSSE({ event: "error", data: JSON.stringify({
          type: "error", error: { type: "api_error", message: errMsg },
        }) });
        dbg("done", { totalLen, chunkCount, err: errMsg });
        return;
      }
      if (finalReplyText && finalReplyText.startsWith(streamedText)) {
        const suffix = finalReplyText.slice(streamedText.length);
        if (suffix) {
          totalLen += suffix.length;
          chunkCount++;
          await s.writeSSE({ event: "content_block_delta", data: JSON.stringify({
            type: "content_block_delta", index: 0, delta: { type: "text_delta", text: suffix },
          }) });
        }
      } else if (finalReplyText && streamedText && finalReplyText !== streamedText) {
        logger.warn("anthropic stream: final reply diverges from streamed text; keeping streamed text");
      }
      outputTokens = approxTokens(finalReplyText || streamedText);

      await s.writeSSE({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) });
      await s.writeSSE({ event: "message_delta", data: JSON.stringify({
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens },
      }) });
      await s.writeSSE({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
      dbg("done", { totalLen, chunkCount, err: runError !== null ? (runError as Error).message : null });
    });
  });
}

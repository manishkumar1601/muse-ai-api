import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { approxTokens, flattenMessages, sessionKeyFromReq, validateChatBody } from "./common.js";
import { openaiError, upstreamStatus } from "./errors.js";
import type { ChatMessage } from "./common.js";
import type { PresentationEvent } from "../hatch/chat.js";
import { logger } from "../log.js";

export interface OpenAIDeps {
  cfg: Config;
  runChat(
    userText: string,
    onDelta?: (chunk: string) => void,
    sessionKey?: string,
    signal?: AbortSignal,
    onPresentation?: (p: PresentationEvent) => void,
  ): Promise<{ replyText: string; messageId: string; presentations?: PresentationEvent[] }>;
}

export function registerOpenAI(app: Hono, deps: OpenAIDeps): void {
  const { cfg } = deps;

  app.get("/v1/models", (c) => {
    const deny = requireAuth(c, cfg.proxyKey, "openai");
    if (deny) return deny;
    return c.json({
      object: "list",
      data: [{ id: cfg.model, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "muse-proxy" }],
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey, "openai");
    if (deny) return deny;

    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return openaiError(c, 400, "invalid_request_error", "invalid JSON body");
    }

    const invalid = validateChatBody(body);
    if (invalid) return openaiError(c, 400, "invalid_request_error", invalid);

    const userText = flattenMessages(body.messages ?? []);
    if (!userText.trim()) {
      return openaiError(c, 400, "invalid_request_error", "no non-empty user message");
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
        return openaiError(c, upstreamStatus(e), "server_error", msg);
      }
      const pt = approxTokens(userText);
      const ct = approxTokens(r.replyText);
      const pres = r.presentations ?? [];
      return c.json({
        id: `chatcmpl-${r.messageId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: r.replyText }, finish_reason: "stop" }],
        usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
        ...(pres.length > 0 ? { x_muse_presentations: pres } : {}),
      });
    }

    return streamSSE(c, async (s) => {
      const messageId = randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-${messageId}`;

      await s.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
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

      let completionTokens = 0;
      let streamedText = "";
      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.t === "pres") {
            await s.writeSSE({ data: JSON.stringify({
              id, object: "chat.completion.chunk", created, model,
              choices: [], x_muse_presentation: item.v,
            }) });
            continue;
          }
          const chunk = item.v;
          streamedText += chunk;
          await s.writeSSE({ data: JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          }) });
        }
        if (!done) {
          await new Promise<void>((resolve) => {
            onPush = () => { onPush = null; resolve(); };
            if (done || queue.length > 0) {
              onPush?.();
            }
          });
        }
      }
      await run;

      if (finalReplyText && finalReplyText.startsWith(streamedText)) {
        const suffix = finalReplyText.slice(streamedText.length);
        if (suffix) {
          await s.writeSSE({ data: JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }],
          }) });
        }
      } else if (finalReplyText && streamedText && finalReplyText !== streamedText) {
        logger.warn("openai stream: final reply diverges from streamed text; keeping streamed text");
      }
      completionTokens = approxTokens(finalReplyText || streamedText);

      if (runError !== null) {
        // Emit a terminal error chunk and stop — do NOT follow it with a
        // finish_reason:"stop" chunk, which SDK consumers read as success.
        // ponytail: explicit !== null because TS CFA narrows the closure-assigned var to never with just if(runError).
        const errMsg = (runError as Error).message;
        await s.writeSSE({ data: JSON.stringify({
          id, object: "chat.completion.chunk", created, model,
          error: { type: "server_error", message: errMsg },
          choices: [{ index: 0, delta: {} }],
        }) });
        logger.warn({ err: errMsg }, "openai stream: runChat error");
        await s.writeSSE({ data: "[DONE]" });
        return;
      }

      await s.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) });
      const pt = approxTokens(userText);
      await s.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [],
        usage: { prompt_tokens: pt, completion_tokens: completionTokens, total_tokens: pt + completionTokens },
      }) });
      await s.writeSSE({ data: "[DONE]" });
    });
  });
}

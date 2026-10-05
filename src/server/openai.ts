import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { flattenMessages, sessionKeyFromReq } from "./common.js";
import type { ChatMessage } from "./common.js";
import { logger } from "../log.js";

export interface OpenAIDeps {
  cfg: Config;
  runChat(userText: string, onDelta?: (chunk: string) => void, sessionKey?: string): Promise<{ replyText: string; messageId: string }>;
}

export function registerOpenAI(app: Hono, deps: OpenAIDeps): void {
  const { cfg } = deps;

  app.get("/v1/models", (c) => {
    const deny = requireAuth(c, cfg.proxyKey);
    if (deny) return deny;
    return c.json({
      object: "list",
      data: [{ id: cfg.model, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "muse-proxy" }],
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey);
    if (deny) return deny;

    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "invalid_request", message: "invalid JSON body" } }, 400);
    }

    const userText = flattenMessages(body.messages ?? []);
    if (!userText.trim()) {
      return c.json({ error: { type: "invalid_request", message: "no non-empty user message" } }, 400);
    }

    const model = body.model ?? cfg.model;
    const stream = body.stream === true;
    const sKey = sessionKeyFromReq(c);

    if (!stream) {
      let r: { replyText: string; messageId: string };
      try {
        r = await deps.runChat(userText, undefined, sKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: { type: "service_unavailable", message: msg } }, 503);
      }
      return c.json({
        id: `chatcmpl-${r.messageId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: r.replyText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

      const queue: string[] = [];
      let done = false;
      let onPush: (() => void) | null = null;
      const push = (t: string) => { queue.push(t); onPush?.(); };
      let runError: Error | null = null;
      const run = deps.runChat(userText, push, sKey)
        .catch((e: unknown) => { runError = e instanceof Error ? e : new Error(String(e)); })
        .finally(() => { done = true; onPush?.(); });

      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const chunk = queue.shift()!;
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

      if (runError !== null) {
        // Emit an error chunk before the stop chunk so informed clients can detect it.
        // finish_reason stays "stop" for OpenAI-client compatibility (not "error").
        // ponytail: explicit !== null because TS CFA narrows the closure-assigned var to never with just if(runError).
        const errMsg = (runError as Error).message;
        await s.writeSSE({ data: JSON.stringify({
          id, object: "chat.completion.chunk", created, model,
          error: { type: "server_error", message: errMsg },
          choices: [{ index: 0, delta: {} }],
        }) });
        logger.warn({ err: errMsg }, "openai stream: runChat error");
      }

      await s.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) });
      await s.writeSSE({ data: "[DONE]" });
    });
  });
}

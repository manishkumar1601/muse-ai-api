import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { flattenMessages } from "./common.js";
import type { ChatMessage } from "./common.js";

export interface OpenAIDeps {
  cfg: Config;
  runChat(userText: string, onDelta?: (chunk: string) => void): Promise<{ replyText: string; messageId: string }>;
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

    if (!stream) {
      const r = await deps.runChat(userText);
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
      const run = deps.runChat(userText, push)
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

      if (runError) {
        await s.writeSSE({ data: JSON.stringify({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        }) as any });
      }

      await s.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) });
      await s.writeSSE({ data: "[DONE]" });
    });
  });
}

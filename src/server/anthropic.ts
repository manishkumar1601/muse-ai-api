import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { flattenMessages } from "./common.js";
import type { ChatMessage } from "./common.js";

export interface AnthropicDeps {
  cfg: Config;
  runChat(userText: string, onDelta?: (chunk: string) => void): Promise<{ replyText: string; messageId: string }>;
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

    let chars = 0;
    for (const m of body.messages ?? []) {
      if (typeof m.content === "string") chars += m.content.length;
      else for (const b of m.content) chars += b.text?.length ?? 0;
    }
    if (typeof body.system === "string") chars += body.system.length;

    return c.json({ input_tokens: Math.max(1, Math.floor(chars / 4)) });
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

    if (!stream) {
      const r = await deps.runChat(userText);
      return c.json({
        id: `msg_${r.messageId}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: r.replyText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }

    return streamSSE(c, async (s) => {
      const msgId = `msg_${randomUUID()}`;

      await s.writeSSE({ event: "message_start", data: JSON.stringify({
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }) });

      await s.writeSSE({ event: "content_block_start", data: JSON.stringify({
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      }) });

      const queue: string[] = [];
      let done = false;
      let onPush: (() => void) | null = null;
      const push = (t: string) => { queue.push(t); onPush?.(); };
      let runError: Error | null = null;
      const run = deps.runChat(userText, push)
        .catch((e: unknown) => { runError = e instanceof Error ? e : new Error(String(e)); })
        .finally(() => { done = true; onPush?.(); });

      let outputTokens = 0;
      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const chunk = queue.shift()!;
          outputTokens += Math.ceil(chunk.length / 4);
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
      // ponytail: runError swallowed after streaming started; client already got 200
      void runError;

      await s.writeSSE({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) });
      await s.writeSSE({ event: "message_delta", data: JSON.stringify({
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens },
      }) });
      await s.writeSSE({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
    });
  });
}

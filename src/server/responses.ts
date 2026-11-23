import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { requireAuth } from "./auth.js";
import { approxTokens, flattenMessages, sessionKeyFromReq } from "./common.js";
import type { ChatMessage } from "./common.js";
import { openaiError, upstreamStatus } from "./errors.js";
import type { PresentationEvent } from "../hatch/chat.js";
import { logger } from "../log.js";

// OpenAI Responses API (POST /v1/responses) — the only wire protocol
// current Codex CLI speaks (wire_api = "chat" was removed upstream).
// Requests are translated onto the same flattened-prompt chat flow as
// /v1/chat/completions; replies are shaped back as Responses objects /
// Responses SSE events.
//
// Deliberate simplifications (documented in docs/openai-compat.md):
// - Stateless: previous_response_id is accepted but not resolved —
//   Codex sends the full conversation every turn (store: false).
// - Tool definitions in the request are ignored: the upstream Muse
//   agent runs its own tools server-side and answers in text, so
//   replies never contain function_call items.

export interface ResponsesDeps {
  cfg: Config;
  runChat(
    userText: string,
    onDelta?: (chunk: string) => void,
    sessionKey?: string,
    signal?: AbortSignal,
    onPresentation?: (p: PresentationEvent) => void,
  ): Promise<{ replyText: string; messageId: string; presentations?: PresentationEvent[] }>;
}

interface ResponsesBody {
  model?: string;
  instructions?: unknown;
  input?: unknown;
  stream?: boolean;
}

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const p = part as { type?: unknown; text?: unknown };
  if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
    return p.text;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).join("");
  return "";
}

// Translate a Responses `input` (+ `instructions`) into chat messages
// that flattenMessages() understands.
export function responsesInputToMessages(body: ResponsesBody): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as { type?: unknown; role?: unknown; content?: unknown; name?: unknown; arguments?: unknown; call_id?: unknown; output?: unknown };
    if (it.type === "function_call") {
      const name = typeof it.name === "string" ? it.name : "unknown_tool";
      const args = typeof it.arguments === "string" ? it.arguments : "";
      messages.push({ role: "assistant", content: `[called tool ${name} with arguments ${args}]` });
    } else if (it.type === "function_call_output") {
      const callId = typeof it.call_id === "string" ? it.call_id : "unknown_call";
      messages.push({ role: "user", content: `[tool result for ${callId}]\n${contentText(it.output) || (typeof it.output === "string" ? it.output : "")}` });
    } else if (it.type === "reasoning" || it.type === "item_reference") {
      continue; // no user-visible text to forward
    } else {
      // message items (type "message" or bare {role, content})
      const role = typeof it.role === "string" ? it.role : "user";
      messages.push({ role, content: contentText(it.content) });
    }
  }
  return messages;
}

export function validateResponsesBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const input = (body as ResponsesBody).input;
  if (input === undefined) return "input is required";
  if (typeof input !== "string" && !Array.isArray(input)) {
    return "input must be a string or an array of items";
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== "object" || item === null) return "each input item must be an object";
    }
  }
  return null;
}

function responseObject(args: {
  id: string;
  model: string;
  status: "in_progress" | "completed" | "failed";
  replyText?: string;
  itemId?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  error?: { code: string; message: string };
}): Record<string, unknown> {
  const { id, model, status } = args;
  const output: Record<string, unknown>[] = [];
  if (args.replyText !== undefined && args.itemId) {
    output.push({
      type: "message",
      id: args.itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: args.replyText, annotations: [] }],
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    ...(args.replyText !== undefined ? { output_text: args.replyText } : {}),
    ...(args.usage ? { usage: args.usage } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}

export function registerResponses(app: Hono, deps: ResponsesDeps): void {
  const { cfg } = deps;

  app.post("/v1/responses", async (c) => {
    const deny = requireAuth(c, cfg.proxyKey, "openai");
    if (deny) return deny;

    let body: ResponsesBody;
    try {
      body = (await c.req.json()) as ResponsesBody;
    } catch {
      return openaiError(c, 400, "invalid_request_error", "invalid JSON body");
    }

    const invalid = validateResponsesBody(body);
    if (invalid) return openaiError(c, 400, "invalid_request_error", invalid);

    const userText = flattenMessages(responsesInputToMessages(body));
    if (!userText.trim()) {
      return openaiError(c, 400, "invalid_request_error", "no non-empty input");
    }

    const model = body.model ?? cfg.model;
    const stream = body.stream === true;
    const sKey = sessionKeyFromReq(c);
    const inputTokens = approxTokens(userText);

    if (!stream) {
      let r: { replyText: string; messageId: string; presentations?: PresentationEvent[] };
      try {
        r = await deps.runChat(userText, undefined, sKey, c.req.raw.signal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return openaiError(c, upstreamStatus(e), "server_error", msg);
      }
      const outputTokens = approxTokens(r.replyText);
      const pres = r.presentations ?? [];
      return c.json({
        ...responseObject({
          id: `resp_${r.messageId}`,
          model,
          status: "completed",
          replyText: r.replyText,
          itemId: `msg_${r.messageId}`,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        }),
        ...(pres.length > 0 ? { x_muse_presentations: pres } : {}),
      });
    }

    return streamSSE(c, async (s) => {
      const respId = `resp_${randomUUID()}`;
      const itemId = `msg_${randomUUID()}`;
      let seq = 0;
      const send = async (event: string, data: Record<string, unknown>): Promise<void> => {
        await s.writeSSE({ event, data: JSON.stringify({ type: event, sequence_number: seq++, ...data }) });
      };

      await send("response.created", {
        response: responseObject({ id: respId, model, status: "in_progress" }),
      });
      await send("response.in_progress", {
        response: responseObject({ id: respId, model, status: "in_progress" }),
      });
      await send("response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
      });
      await send("response.content_part.added", {
        item_id: itemId, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });

      const queue: string[] = [];
      let done = false;
      let onPush: (() => void) | null = null;
      const push = (t: string) => { queue.push(t); onPush?.(); };
      let runError: Error | null = null;
      let finalReplyText = "";
      const run = deps.runChat(userText, push, sKey, c.req.raw.signal)
        .then((result) => { finalReplyText = result.replyText; })
        .catch((e: unknown) => { runError = e instanceof Error ? e : new Error(String(e)); })
        .finally(() => { done = true; onPush?.(); });

      let streamedText = "";
      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const chunk = queue.shift()!;
          streamedText += chunk;
          await send("response.output_text.delta", {
            item_id: itemId, output_index: 0, content_index: 0, delta: chunk,
          });
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
        const errMsg = (runError as Error).message;
        logger.warn({ err: errMsg }, "responses stream: runChat error");
        await send("response.failed", {
          response: {
            ...responseObject({ id: respId, model, status: "failed" }),
            error: { code: "server_error", message: errMsg },
          },
        });
        return;
      }

      if (finalReplyText && finalReplyText.startsWith(streamedText)) {
        const suffix = finalReplyText.slice(streamedText.length);
        if (suffix) {
          streamedText += suffix;
          await send("response.output_text.delta", {
            item_id: itemId, output_index: 0, content_index: 0, delta: suffix,
          });
        }
      } else if (finalReplyText && streamedText && finalReplyText !== streamedText) {
        logger.warn("responses stream: final reply diverges from streamed text; keeping streamed text");
      }

      const outputTokens = approxTokens(finalReplyText || streamedText);
      await send("response.output_text.done", {
        item_id: itemId, output_index: 0, content_index: 0, text: streamedText,
      });
      await send("response.content_part.done", {
        item_id: itemId, output_index: 0, content_index: 0,
        part: { type: "output_text", text: streamedText, annotations: [] },
      });
      await send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message", id: itemId, status: "completed", role: "assistant",
          content: [{ type: "output_text", text: streamedText, annotations: [] }],
        },
      });
      await send("response.completed", {
        response: responseObject({
          id: respId, model, status: "completed",
          replyText: streamedText, itemId,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        }),
      });
    });
  });
}

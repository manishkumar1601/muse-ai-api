import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { HatchClient } from "./client.js";
import type { ChatSessionState } from "./sessions.js";
import { logger } from "../log.js";

const DEBUG = process.env["PROXY_DEBUG"] !== "0";
const dbg = (tag: string, data: unknown): void => {
  if (!DEBUG) return;
  try { appendFileSync("proxy-debug.log", `[${new Date().toISOString()}] chat.${tag}: ${JSON.stringify(data)}\n`); } catch {}
};

export const CAPABILITIES: readonly string[] = [
  "chat_cancel",
  "delta_stream",
  "custom_reactions",
  "custom_reactions_facebook_thumbs_up_v1",
];

export interface SendAndCollectArgs {
  client: HatchClient;
  userText: string;
  timezone: string;
  listenMs: number;
  onDelta?: (chunk: string) => void;
  clientId?: string;
  sessionState?: ChatSessionState;
}

export interface SendAndCollectResult {
  replyText: string;
  messageId: string;
  events: Record<string, unknown>[];
}

export async function sendAndCollectReply(
  args: SendAndCollectArgs,
): Promise<SendAndCollectResult> {
  const clientId = args.clientId ?? args.sessionState?.nodeId ?? randomUUID();
  const sessionId = args.sessionState?.sessionId;

  // Side chat: skip WS subscribe entirely. Fire send + poll /chat/history.
  // Subscribe deltas race the thread creation unreliably; history poll
  // sees the stored reply once muse finishes generating. Faster + reliable.
  if (sessionId) return sideChatSendAndPoll(args, clientId, sessionId);

  // Main chat: register as push target, open subscribe, wait for deltas.
  const _registerNodeSid = args.client.request("POST", "/api/nodes/register", {
    node_id: clientId, display_name: "muse-proxy", platform: "windows",
    commands_v2: { ping: { description: "Connection liveness check" } },
  });
  const _registerSid = args.client.request("POST", "/client/register-capabilities", {
    client_id: clientId, platform: "web", display_name: "muse-proxy", version: "0.0.0",
    capabilities: {
      data_sources: {}, device_commands: {}, hatch_app_commands: {},
      rendering: {
        supported_presentations: ["text_with_button", "generic_list"],
        supported_inline_presentations: ["option"],
        supported_text_entities: [],
      },
    },
  });

  const streamBody = {
    message: args.userText, node_id: clientId,
    capabilities: [...CAPABILITIES], timezone: args.timezone,
  };
  const subscribeSid = args.client.request("POST", "/chat/subscribe", {
    after_stream_seq: 0, after_chat_event_seq: 0, capabilities: [...CAPABILITIES],
  });

  let sendStartMs = Date.now();
  let sendSid: bigint | null = null;
  const events: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  let ackMessageId: string | undefined;
  const deadline = Date.now() + args.listenMs;

  outer: while (Date.now() < deadline) {
    if (sendSid === null && args.client.hasResponded(subscribeSid)) {
      sendStartMs = Date.now();
      sendSid = args.client.request("POST", "/chat/stream", streamBody);
    }
    const r = await args.client.recvOne();
    if (r === null) continue;
    if (r === "closed") break;
    if (r.kind === "reset") {
      logger.warn({ streamId: String(r.streamId), code: r.code, reason: r.reason }, "hatch: reset received");
      continue;
    }
    if (r.kind === "complete") {
      if (sendSid !== null && r.streamId === sendSid) {
        const body = r.body as Record<string, unknown>;
        if (typeof body === "object" && body !== null && typeof body["message_id"] === "string") {
          ackMessageId = body["message_id"] as string;
        }
      }
      continue;
    }
    if (r.kind !== "event") continue;

    const obj = r.obj;
    const tsMs = obj["ts_ms"];
    if (typeof tsMs === "number" && tsMs < sendStartMs) continue;

    events.push(obj);
    const ev = obj["event"] as string;
    const payload = (obj["payload"] ?? {}) as Record<string, unknown>;

    if (ev === "delta.text_append") {
      const text = (payload["text"] ?? payload["delta"] ?? "") as string;
      textParts.push(text);
      args.onDelta?.(text);
    } else if (ev === "delta.message_done") {
      if (textParts.length === 0) {
        const transcript = payload["transcript"] as Record<string, unknown> | undefined;
        const messages = (transcript?.["messages"] ?? []) as Record<string, unknown>[];
        for (const m of messages) {
          const content = (m["content"] ?? []) as Record<string, unknown>[];
          for (const c of content) {
            if (c["type"] === "text" && typeof c["text"] === "string") {
              textParts.push(c["text"] as string);
            }
          }
        }
      }
      break outer;
    } else if (ev === "message.assistant") {
      if (textParts.length === 0) {
        const t = (payload["display_text"] ?? payload["content"] ?? "") as string;
        if (t) { textParts.push(t); args.onDelta?.(t); }
      }
      break outer;
    }
  }

  return { replyText: textParts.join(""), messageId: ackMessageId ?? randomUUID(), events };
}

async function sideChatSendAndPoll(
  args: SendAndCollectArgs,
  clientId: string,
  sessionId: string,
): Promise<SendAndCollectResult> {
  args.client.request("POST", "/api/nodes/register", {
    node_id: clientId, display_name: "muse-proxy", platform: "windows",
    commands_v2: { ping: { description: "Connection liveness check" } },
  });

  const sendSid = args.client.request("POST", "/chat/stream", {
    message: args.userText, node_id: clientId,
    capabilities: [...CAPABILITIES], timezone: args.timezone,
    session_id: sessionId,
    metadata: { thread_is_dictation_used: false },
  });

  // Wait for the sync ack (gives us message_id).
  let ackMessageId: string | undefined;
  const ackDeadline = Date.now() + 10_000;
  while (!ackMessageId && Date.now() < ackDeadline) {
    const r = await args.client.recvOne();
    if (r === null) continue;
    if (r === "closed") break;
    if (r.kind === "complete" && r.streamId === sendSid) {
      const body = r.body as Record<string, unknown>;
      if (typeof body === "object" && body !== null && typeof body["message_id"] === "string") {
        ackMessageId = body["message_id"] as string;
      }
      break;
    }
  }
  if (!ackMessageId) {
    return { replyText: "", messageId: randomUUID(), events: [] };
  }

  // Poll /chat/history until the assistant reply is STABLE (same text in two
  // consecutive polls). display_text_ready + status==completed are not enough
  // on their own — muse flips them true on intermediate snapshots.
  const path = `/chat/history?limit=40&transcript_mode=messages&session_id=${sessionId}`;
  const deadline = Date.now() + args.listenMs;
  let lastText: string | null = null;
  let emittedLen = 0;
  while (Date.now() < deadline) {
    const sid = args.client.request("GET", path);
    const pollDeadline = Math.min(Date.now() + 3000, deadline);
    let currentText: string | null = null;
    while (Date.now() < pollDeadline) {
      const r = await args.client.recvOne();
      if (r === null) continue;
      if (r === "closed") break;
      if (r.kind === "complete" && r.streamId === sid) {
        const body = r.body as { result?: { chat_events?: Array<Record<string, unknown>> } };
        const events = body?.result?.chat_events ?? [];
        const ourIdx = events.findIndex((e) => e["message_id"] === ackMessageId);
        if (ourIdx >= 0) {
          for (const e of events.slice(ourIdx + 1)) {
            if (e["event_name"] !== "message.assistant") continue;
            if (typeof e["display_text"] !== "string") continue;
            currentText = e["display_text"] as string;
            break;
          }
        }
        break;
      }
    }
    dbg("poll", { len: currentText?.length ?? null, lastLen: lastText?.length ?? null, preview: currentText?.slice(0, 80) ?? null });
    if (currentText !== null) {
      if (args.onDelta && currentText.length > emittedLen) {
        const fresh = currentText.slice(emittedLen);
        for (let i = 0; i < fresh.length; i += 300) {
          args.onDelta(fresh.slice(i, i + 300));
          await new Promise((r) => setTimeout(r, 5));
        }
        emittedLen = currentText.length;
      }
      if (lastText === currentText && currentText.length > 0) {
        dbg("stable", { len: currentText.length });
        return { replyText: currentText, messageId: ackMessageId, events: [] };
      }
      lastText = currentText;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { replyText: lastText ?? "", messageId: ackMessageId, events: [] };
}

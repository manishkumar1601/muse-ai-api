import { randomUUID } from "node:crypto";
import type { HatchClient } from "./client.js";
import type { ChatSessionState } from "./sessions.js";
import { logger } from "../log.js";

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
  // Stable per-session nodeId doubles as the register-capabilities client_id,
  // so muse routes side-chat events (created under this identity) back to us.
  const clientId = args.clientId ?? args.sessionState?.nodeId ?? randomUUID();

  // Register the node first so muse treats it as a valid push target.
  // Without this, side-chat events never reach us (muse falls back to
  // broadcasting main-chat events but drops thread-scoped ones).
  const _registerNodeSid = args.client.request("POST", "/api/nodes/register", {
    node_id: clientId,
    display_name: "muse-proxy",
    platform: "windows",
    commands_v2: { ping: { description: "Connection liveness check" } },
  });

  const _registerSid = args.client.request("POST", "/client/register-capabilities", {
    client_id: clientId,
    platform: "web",
    display_name: "muse-proxy",
    version: "0.0.0",
    capabilities: {
      data_sources: {},
      device_commands: {},
      hatch_app_commands: {},
      rendering: {
        supported_presentations: ["text_with_button", "generic_list"],
        supported_inline_presentations: ["option"],
        supported_text_entities: [],
      },
    },
  });

  const sessionId = args.sessionState?.sessionId;

  const streamBody: Record<string, unknown> = {
    message: args.userText,
    node_id: clientId,
    capabilities: [...CAPABILITIES],
    timezone: args.timezone,
  };
  // Client-chosen UUID — first use creates a new side chat on muse.ai,
  // subsequent uses route to the same thread. Omit to use the main chat.
  if (sessionId) {
    streamBody["session_id"] = sessionId;
    streamBody["metadata"] = { thread_is_dictation_used: false };
  }

  // Always open a global subscribe (no session_id). For side chats also open
  // a thread-scoped subscribe — the two run concurrently and events from
  // either are consumed by the same recvOne loop.
  const subscribeSid = args.client.request("POST", "/chat/subscribe", {
    after_stream_seq: 0,
    after_chat_event_seq: 0,
    capabilities: [...CAPABILITIES],
  });
  if (sessionId) {
    args.client.request("POST", "/chat/subscribe", {
      after_stream_seq: 0,
      after_chat_event_seq: 0,
      capabilities: [...CAPABILITIES],
      session_id: sessionId,
    });
  }

  let sendStartMs = Date.now();
  let sendSid: bigint | null = null;

  const events: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  let ackMessageId: string | undefined;
  const deadline = Date.now() + args.listenMs;

  outer: while (Date.now() < deadline) {
    // Main chat path: fire /chat/stream after subscribe attaches so no deltas
    // are lost. Side-chat path already fired above (so the thread exists
    // before subscribe) and sendSid is already set.
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
    // For side chats we need the replay (first assistant reply might land
    // before we subscribed), so skip the drop-replay filter when scoped.
    if (!sessionId && typeof tsMs === "number" && tsMs < sendStartMs) continue;

    events.push(obj);

    const ev = obj["event"] as string;
    const payload = (obj["payload"] ?? {}) as Record<string, unknown>;

    if (ev === "delta.text_append") {
      const text = ((payload["text"] ?? payload["delta"] ?? "") as string);
      textParts.push(text);
      args.onDelta?.(text);
    } else if (ev === "delta.message_done") {
      if (textParts.length === 0) {
        // Fallback: extract from transcript
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
      // Side chats emit a non-delta assistant message when the reply is short
      // enough to not stream. display_text / content holds the whole text.
      if (textParts.length === 0) {
        const t = (payload["display_text"] ?? payload["content"] ?? "") as string;
        if (t) {
          textParts.push(t);
          args.onDelta?.(t);
        }
      }
      break outer;
    }
  }

  // Fallback for side chats: if WS deltas didn't arrive (common on first
  // message to a brand-new thread), fetch the assistant reply from history.
  if (sessionId && textParts.length === 0 && ackMessageId) {
    const reply = await fetchAssistantReplyFromHistory(args.client, sessionId, ackMessageId, args.listenMs);
    if (reply) {
      textParts.push(reply);
      args.onDelta?.(reply);
    }
  }

  return {
    replyText: textParts.join(""),
    messageId: ackMessageId ?? randomUUID(),
    events,
  };
}

async function fetchAssistantReplyFromHistory(
  client: HatchClient,
  sessionId: string,
  afterMessageId: string,
  totalBudgetMs: number,
): Promise<string | null> {
  const start = Date.now();
  const deadline = start + Math.min(totalBudgetMs, 15_000);
  const path = `/chat/history?limit=40&transcript_mode=messages&session_id=${sessionId}`;
  while (Date.now() < deadline) {
    const sid = client.request("GET", path);
    // Spin recvOne until we see the complete for this GET or timeout.
    const pollDeadline = Math.min(Date.now() + 2000, deadline);
    while (Date.now() < pollDeadline) {
      const r = await client.recvOne();
      if (r === null) continue;
      if (r === "closed") return null;
      if (r.kind === "complete" && r.streamId === sid) {
        const body = r.body as { result?: { chat_events?: Array<Record<string, unknown>> } };
        const events = body?.result?.chat_events ?? [];
        const ourIdx = events.findIndex(e => e["message_id"] === afterMessageId);
        if (ourIdx >= 0) {
          for (const e of events.slice(ourIdx + 1)) {
            if (e["event_name"] === "message.assistant" && typeof e["display_text"] === "string") {
              return e["display_text"] as string;
            }
          }
        }
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

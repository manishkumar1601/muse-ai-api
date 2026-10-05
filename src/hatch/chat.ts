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
  sessionId?: string;
  channel?: string;
}

export async function sendAndCollectReply(
  args: SendAndCollectArgs,
): Promise<SendAndCollectResult> {
  const clientId = args.clientId ?? randomUUID();

  // ponytail: three fire-and-forget requests; no await needed — recvOne drains responses.
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

  const _subscribeSid = args.client.request("POST", "/chat/subscribe", {
    after_stream_seq: 0,
    after_chat_event_seq: 0,
    capabilities: [...CAPABILITIES],
  });

  const sendStartMs = Date.now();

  const streamBody: Record<string, unknown> = {
    message: args.userText,
    node_id: clientId,
    capabilities: [...CAPABILITIES],
    timezone: args.timezone,
  };
  if (args.sessionState?.sessionId) streamBody["session_id"] = args.sessionState.sessionId;
  if (args.sessionState?.channel) streamBody["channel"] = args.sessionState.channel;

  const sendSid = args.client.request("POST", "/chat/stream", streamBody);

  const events: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  let ackMessageId: string | undefined;
  let ackSessionId: string | undefined;
  let ackChannel: string | undefined;
  const deadline = Date.now() + args.listenMs;

  outer: while (Date.now() < deadline) {
    const r = await args.client.recvOne();

    if (r === null) continue;
    if (r === "closed") break;

    if (r.kind === "reset") {
      logger.warn({ streamId: String(r.streamId), code: r.code, reason: r.reason }, "hatch: reset received");
      continue;
    }

    if (r.kind === "complete") {
      if (r.streamId === sendSid) {
        const body = r.body as Record<string, unknown>;
        if (typeof body === "object" && body !== null) {
          if (typeof body["message_id"] === "string") ackMessageId = body["message_id"] as string;
          if (typeof body["session_id"] === "string") ackSessionId = body["session_id"] as string;
          if (typeof body["channel"] === "string") ackChannel = body["channel"] as string;
        }
      }
      continue;
    }

    if (r.kind !== "event") continue;

    const obj = r.obj;
    const tsMs = obj["ts_ms"];
    if (typeof tsMs === "number" && tsMs < sendStartMs) continue; // drop replay

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
    }
  }

  return {
    replyText: textParts.join(""),
    messageId: ackMessageId ?? randomUUID(),
    events,
    ...(ackSessionId !== undefined ? { sessionId: ackSessionId } : {}),
    ...(ackChannel !== undefined ? { channel: ackChannel } : {}),
  };
}

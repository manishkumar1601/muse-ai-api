import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { HatchClient } from "./client.js";
import type { ChatSessionState } from "./sessions.js";
import { logger } from "../log.js";

const DEBUG = process.env["PROXY_DEBUG"] === "1";
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

export interface PresentationEvent {
  kind: string;
  ts_ms?: number;
  payload: Record<string, unknown>;
}

// Non-text events we forward to clients as x_muse_presentations. Everything else
// (agent.status, chat.seen, reactions.updated, message.user, text deltas,
// message terminators) stays internal.
const PRESENTATION_KINDS: ReadonlySet<string> = new Set([
  "delta.presentation",
  "delta.inline_option",
  "widget.state_updated",
  "task.status",
  "approvals.snapshot",
]);

export interface SendAndCollectArgs {
  client: HatchClient;
  userText: string;
  timezone: string;
  listenMs: number;
  onDelta?: (chunk: string) => void;
  onPresentation?: (p: PresentationEvent) => void;
  clientId?: string;
  sessionState?: ChatSessionState;
  signal?: AbortSignal;
}

export interface SendAndCollectResult {
  replyText: string;
  messageId: string;
  events: Record<string, unknown>[];
  presentations: PresentationEvent[];
}

export class MuseChatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseChatTimeoutError";
  }
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
  const presentations: PresentationEvent[] = [];
  const textParts: string[] = [];
  let ackMessageId: string | undefined;
  const deadline = Date.now() + args.listenMs;
  let stopAckWait = false;
  let completed = false;

  // Background ack waiter on sendSid. Multiplex: sendSid delivers the sync-ack
  // complete; subscribeSid delivers the streamed events. Independent reads.
  const ackP = (async () => {
    while (!args.signal?.aborted && !stopAckWait && !ackMessageId && Date.now() < deadline) {
      if (sendSid === null) { await new Promise((r) => setTimeout(r, 20)); continue; }
      const r = await args.client.recvOne(sendSid, Math.min(1500, deadline - Date.now()));
      if (r === null) continue;
      if (r === "closed") return;
      if (r.kind === "complete") {
        const body = r.body as Record<string, unknown>;
        if (typeof body === "object" && body !== null && typeof body["message_id"] === "string") {
          ackMessageId = body["message_id"] as string;
        }
        return;
      }
    }
  })();

  outer: while (!args.signal?.aborted && Date.now() < deadline) {
    if (sendSid === null && args.client.hasResponded(subscribeSid)) {
      sendStartMs = Date.now();
      sendSid = args.client.request("POST", "/chat/stream", streamBody);
    }
    const r = await args.client.recvOne(subscribeSid);
    if (r === null) continue;
    if (r === "closed") break;
    if (r.kind === "reset") {
      logger.warn({ streamId: String(r.streamId), code: r.code, reason: r.reason }, "hatch: reset received");
      continue;
    }
    if (r.kind !== "event") continue;

    const obj = r.obj;
    const tsMs = obj["ts_ms"];
    if (typeof tsMs === "number" && tsMs < sendStartMs - 5000) continue;

    events.push(obj);
    const ev = obj["event"] as string;
    const payload = (obj["payload"] ?? {}) as Record<string, unknown>;

    if (PRESENTATION_KINDS.has(ev)) {
      const p: PresentationEvent = { kind: ev, payload, ...(typeof tsMs === "number" ? { ts_ms: tsMs } : {}) };
      presentations.push(p);
      args.onPresentation?.(p);
      continue;
    }

    if (ev === "delta.text_append") {
      const text = (payload["text"] ?? payload["delta"] ?? "") as string;
      textParts.push(text);
      args.onDelta?.(text);
    } else if (ev === "delta.message_done") {
      const transcriptText = extractTranscriptText(payload);
      if (transcriptText) appendFinalText(transcriptText, textParts, args.onDelta);
      completed = true;
      break outer;
    } else if (ev === "message.assistant") {
      const t = (payload["display_text"] ?? payload["content"] ?? "") as string;
      if (t) appendFinalText(t, textParts, args.onDelta);
      completed = true;
      break outer;
    }
  }

  stopAckWait = true;
  if (completed && !ackMessageId) {
    // The reply is already complete — don't add up to ~1.5s of dead time
    // waiting for an ack that only supplies the message id (we fall back
    // to a random id). Give it a short grace period, then move on; the
    // waiter exits on its next loop iteration via stopAckWait.
    await Promise.race([ackP, new Promise((r) => setTimeout(r, 250))]);
  } else {
    await ackP;
  }
  if (!completed && !args.signal?.aborted) throw new MuseChatTimeoutError("Timed out waiting for complete Muse reply");
  return { replyText: textParts.join(""), messageId: ackMessageId ?? randomUUID(), events, presentations };
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
  const ackDeadline = Date.now() + args.listenMs;
  while (!ackMessageId && !args.signal?.aborted && Date.now() < ackDeadline) {
    const r = await args.client.recvOne(sendSid, Math.min(1500, Math.max(1, ackDeadline - Date.now())));
    if (r === null) continue;
    if (r === "closed") break;
    if (r.kind === "complete") {
      const body = r.body as Record<string, unknown>;
      if (typeof body === "object" && body !== null && typeof body["message_id"] === "string") {
        ackMessageId = body["message_id"] as string;
      }
      break;
    }
  }
  if (!ackMessageId) {
    throw new MuseChatTimeoutError("Timed out waiting for Muse chat acknowledgement");
  }

  // Poll /chat/history until the assistant reply is STABLE (same text in two
  // consecutive polls). display_text_ready + status==completed are not enough
  // on their own — muse flips them true on intermediate snapshots.
  const path = `/chat/history?limit=40&transcript_mode=messages&session_id=${sessionId}`;
  const deadline = Date.now() + args.listenMs;
  let lastText: string | null = null;
  let emittedText = "";
  let deltaDiverged = false;
  while (!args.signal?.aborted && Date.now() < deadline) {
    const sid = args.client.request("GET", path);
    const pollDeadline = Math.min(Date.now() + 3000, deadline);
    let currentText: string | null = null;
    while (!args.signal?.aborted && Date.now() < pollDeadline) {
      const r = await args.client.recvOne(sid, Math.min(1500, Math.max(1, pollDeadline - Date.now())));
      if (r === null) continue;
      if (r === "closed") break;
      if (r.kind === "complete") {
        const body = r.body as { result?: { chat_events?: Array<Record<string, unknown>> } };
        const events = body?.result?.chat_events ?? [];
        const ourIdx = events.findIndex((e) => e["message_id"] === ackMessageId);
        if (ourIdx >= 0) {
          for (const e of events.slice(ourIdx + 1)) {
            if (e["event_name"] !== "message.assistant") continue;
            if (typeof e["display_text"] !== "string") continue;
            currentText = e["display_text"] as string;
          }
        }
        break;
      }
    }
    dbg("poll", { len: currentText?.length ?? null, lastLen: lastText?.length ?? null, preview: currentText?.slice(0, 80) ?? null });
    if (currentText !== null) {
      if (args.onDelta && !deltaDiverged && currentText.length > emittedText.length) {
        // Snapshots are assumed append-only. If a later snapshot revises
        // text we already emitted, slicing by length would garble the
        // stream — stop emitting deltas instead (the final replyText
        // returned to the caller is still the correct full text).
        if (!currentText.startsWith(emittedText)) {
          deltaDiverged = true;
          logger.warn("side-chat: snapshot revised already-streamed text; stopping delta emission");
        } else {
          const fresh = currentText.slice(emittedText.length);
          for (let i = 0; i < fresh.length; i += 300) {
            args.onDelta(fresh.slice(i, i + 300));
            await new Promise((r) => setTimeout(r, 5));
          }
          emittedText = currentText;
        }
      }
      if (lastText === currentText && currentText.length > 0) {
        dbg("stable", { len: currentText.length });
        return { replyText: currentText, messageId: ackMessageId, events: [], presentations: [] };
      }
      lastText = currentText;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!args.signal?.aborted) throw new MuseChatTimeoutError("Timed out waiting for complete Muse reply");
  return { replyText: lastText ?? "", messageId: ackMessageId, events: [], presentations: [] };
}

function extractTranscriptText(payload: Record<string, unknown>): string {
  const transcript = payload["transcript"] as Record<string, unknown> | undefined;
  const messages = (transcript?.["messages"] ?? []) as Record<string, unknown>[];
  return messages
    // If the transcript marks speakers, only the assistant's text is the
    // reply — concatenating the user's prompt in would corrupt it.
    // Unmarked messages (the shape in our captures/tests) are kept.
    .filter((message) => {
      const role = message["role"] ?? message["sender"] ?? message["author"];
      return typeof role !== "string" || role === "assistant";
    })
    .flatMap((message) => {
    const content = (message["content"] ?? []) as Record<string, unknown>[];
    return content.flatMap((block) => block["type"] === "text" && typeof block["text"] === "string" ? [block["text"] as string] : []);
  }).join("");
}

function appendFinalText(
  finalText: string,
  textParts: string[],
  onDelta?: (chunk: string) => void,
): void {
  const streamedText = textParts.join("");
  if (finalText.startsWith(streamedText)) {
    const suffix = finalText.slice(streamedText.length);
    if (suffix) onDelta?.(suffix);
  }
  textParts.splice(0, textParts.length, finalText);
}

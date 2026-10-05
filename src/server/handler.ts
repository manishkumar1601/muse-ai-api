import { readFileSync } from "node:fs";
import { bootstrap } from "../bootstrap/session.js";
import type { Session } from "../bootstrap/session.js";
import { HatchClient } from "../hatch/client.js";
import { sendAndCollectReply } from "../hatch/chat.js";
import { getTls } from "../hatch/tls.js";
import { SessionStore, DEFAULT_SESSION_KEY } from "../hatch/sessions.js";
import { logger } from "../log.js";
import type { Config } from "../config.js";

function loadSession(path: string): Session {
  return JSON.parse(readFileSync(path, "utf-8")) as Session;
}

export const chatSessions = new SessionStore();

export async function runChat(
  cfg: Config,
  userText: string,
  onDelta?: (c: string) => void,
  sessionKey: string = DEFAULT_SESSION_KEY,
): Promise<{ replyText: string; messageId: string }> {
  const tls = await getTls();
  const state = chatSessions.get(sessionKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = loadSession(cfg.sessionPath);
      const client = await HatchClient.open(session, tls);
      try {
        const r = await sendAndCollectReply({
          client, userText, timezone: cfg.timezone, listenMs: 60_000,
          sessionState: state,
          ...(onDelta !== undefined ? { onDelta } : {}),
        });
        if (r.sessionId !== undefined || r.channel !== undefined) {
          chatSessions.update(sessionKey, {
            ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
            ...(r.channel !== undefined ? { channel: r.channel } : {}),
          });
        }
        return { replyText: r.replyText, messageId: r.messageId };
      } finally {
        await client.close();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: msg, attempt }, "HatchClient open/run failed");
      if (attempt === 0) {
        try {
          await bootstrap({ storageStatePath: cfg.storageStatePath, sessionPath: cfg.sessionPath });
        } catch (b) {
          const bmsg = b instanceof Error ? b.message : String(b);
          throw new Error(`bootstrap failed: ${bmsg}`);
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

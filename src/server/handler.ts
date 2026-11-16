import { readFileSync } from "node:fs";
import { bootstrap } from "../bootstrap/session.js";
import type { Session } from "../bootstrap/session.js";
import { HatchClient } from "../hatch/client.js";
import { sendAndCollectReply, type PresentationEvent } from "../hatch/chat.js";
import { getTls } from "../hatch/tls.js";
import { createClientPool } from "../hatch/pool.js";
import { SessionStore, DEFAULT_SESSION_KEY } from "../hatch/sessions.js";
import { logger } from "../log.js";
import type { Config } from "../config.js";

function loadSession(path: string): Session {
  return JSON.parse(readFileSync(path, "utf-8")) as Session;
}

export const chatSessions = new SessionStore();

// ponytail: module-level pool — one HatchClient reused across requests, serialized.
// Saves the ~500ms Noise handshake on every request after the first. Caveat: main-chat
// /chat/subscribe is re-sent per call → server-side subscribe streams accumulate. Fine
// until it isn't; move subscribe into pool-open if that bites.
let pool: ReturnType<typeof createClientPool> | null = null;
function getPool(cfg: Config): ReturnType<typeof createClientPool> {
  if (pool !== null) return pool;
  pool = createClientPool({
    openClient: async () => {
      const tls = await getTls();
      const session = loadSession(cfg.sessionPath);
      return HatchClient.open(session, tls);
    },
  });
  return pool;
}

export function resetPool(): Promise<void> {
  const p = pool;
  pool = null;
  return p ? p.reset() : Promise.resolve();
}

export async function runChat(
  cfg: Config,
  userText: string,
  onDelta?: (c: string) => void,
  sessionKey: string = DEFAULT_SESSION_KEY,
  signal?: AbortSignal,
  onPresentation?: (p: PresentationEvent) => void,
): Promise<{ replyText: string; messageId: string; presentations: PresentationEvent[] }> {
  const state = sessionKey === DEFAULT_SESSION_KEY ? undefined : chatSessions.get(sessionKey);
  const p = getPool(cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await p.withClient(async (client) => {
        const r = await sendAndCollectReply({
          client, userText, timezone: cfg.timezone, listenMs: 60_000,
          ...(state !== undefined ? { sessionState: state } : {}),
          ...(onDelta !== undefined ? { onDelta } : {}),
          ...(signal !== undefined ? { signal } : {}),
          ...(onPresentation !== undefined ? { onPresentation } : {}),
        });
        return { replyText: r.replyText, messageId: r.messageId, presentations: r.presentations };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: msg, attempt }, "pool.withClient failed");
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

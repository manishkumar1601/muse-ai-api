import { createHash, randomUUID } from "node:crypto";

export interface ChatSessionState {
  sessionId?: string;
  channel?: string;
  nodeId: string;
  lastUsed: number;
}

export class SessionStore {
  private readonly map = new Map<string, ChatSessionState>();
  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string): ChatSessionState {
    let s = this.map.get(key);
    if (s) {
      // Re-insert so LRU eviction (insertion-order sweep) sees it as most-recent.
      this.map.delete(key);
    } else {
      s = { nodeId: randomUUID(), lastUsed: Date.now() };
    }
    s.lastUsed = Date.now();
    this.map.set(key, s);
    this.sweep();
    return s;
  }

  update(key: string, patch: Partial<ChatSessionState>): void {
    const s = this.map.get(key);
    if (!s) return;
    if (patch.sessionId !== undefined) s.sessionId = patch.sessionId;
    if (patch.channel !== undefined) s.channel = patch.channel;
    s.lastUsed = Date.now();
  }

  size(): number { return this.map.size; }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.lastUsed > this.ttlMs) this.map.delete(k);
    }
    if (this.map.size > this.maxEntries) {
      // ponytail: drop oldest when over cap; insertion order is Map iteration order
      const toDrop = this.map.size - this.maxEntries;
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= toDrop) break;
        this.map.delete(k);
      }
    }
  }
}

export const DEFAULT_SESSION_KEY = "default";

export function deriveSessionKey(headers: {
  xMuseSession?: string | undefined;
  authorization?: string | undefined;
}): string {
  if (headers.xMuseSession && headers.xMuseSession.trim().length > 0) {
    return `h:${headers.xMuseSession.trim()}`;
  }
  if (headers.authorization && headers.authorization.trim().length > 0) {
    return `a:${createHash("sha256").update(headers.authorization).digest("hex").slice(0, 16)}`;
  }
  return DEFAULT_SESSION_KEY;
}

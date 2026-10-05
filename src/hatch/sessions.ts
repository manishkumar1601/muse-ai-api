import { createHash, randomUUID } from "node:crypto";

export interface ChatSessionState {
  // sessionId doubles as the muse.ai thread/side-chat identifier.
  // Fresh UUID per API session; passing it into /chat/stream creates the
  // thread on first use and routes to it on subsequent calls.
  sessionId: string;
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
      this.map.delete(key);
    } else {
      s = { sessionId: randomUUID(), nodeId: randomUUID(), lastUsed: Date.now() };
    }
    s.lastUsed = Date.now();
    this.map.set(key, s);
    this.sweep();
    return s;
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

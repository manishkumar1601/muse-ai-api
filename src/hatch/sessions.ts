import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { logger } from "../log.js";

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
  private readonly tails = new Map<string, Promise<void>>();
  private lastSaveAt = 0;
  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 1000,
    // When set, the key -> chat mapping is persisted to this JSON file so a
    // named session (X-Muse-Session / token) RESUMES the same muse.ai side
    // chat after the proxy restarts, not just while it keeps running.
    private readonly persistPath?: string,
  ) {
    if (this.persistPath) this.load();
  }

  get(key: string): ChatSessionState {
    let s = this.map.get(key);
    if (s && Date.now() - s.lastUsed > this.ttlMs) {
      this.map.delete(key);
      s = undefined;
    }
    let created = false;
    if (s) {
      this.map.delete(key);
    } else {
      s = { sessionId: randomUUID(), nodeId: randomUUID(), lastUsed: Date.now() };
      created = true;
    }
    s.lastUsed = Date.now();
    this.map.set(key, s);
    this.sweep();
    // Save AFTER the new entry is in the map (saving before the set would
    // persist a map that does not contain the session just created).
    if (created) this.saveSoon(true);
    return s;
  }

  size(): number { return this.map.size; }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private loadWarned = false;
  private saveWarned = false;

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.persistPath!, "utf-8");
    } catch {
      return; // no store yet (or unreadable): start fresh, never crash startup
    }
    try {
      const raw = JSON.parse(text) as Record<string, Partial<ChatSessionState>>;
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v?.sessionId === "string" && v.sessionId.length > 0
          && typeof v?.nodeId === "string" && v.nodeId.length > 0
          && typeof v?.lastUsed === "number"
          && v.lastUsed <= now && now - v.lastUsed <= this.ttlMs) {
          this.map.set(k, { sessionId: v.sessionId, nodeId: v.nodeId, lastUsed: v.lastUsed });
        }
      }
      // Enforce the entry cap on load too (keep the most recent entries).
      while (this.map.size > this.maxEntries) {
        const oldest = this.map.keys().next().value as string;
        this.map.delete(oldest);
      }
    } catch {
      if (!this.loadWarned) {
        this.loadWarned = true;
        logger.warn({ path: this.persistPath }, "sessions store is corrupt; starting with no saved sessions");
      }
    }
  }

  // Persist the map. New sessions save immediately (that is the moment a
  // resume target is created); later saves are throttled and happen on
  // sweep pressure. Writes are atomic (per-process tmp + rename) and the
  // final file is forced owner-only. Best-effort: failures are logged
  // once, the in-memory map keeps working.
  private saveSoon(immediate = false): void {
    if (!this.persistPath) return;
    const now = Date.now();
    if (!immediate && now - this.lastSaveAt < 30_000) return;
    this.lastSaveAt = now;
    try {
      const obj: Record<string, ChatSessionState> = {};
      for (const [k, v] of this.map) obj[k] = v;
      const tmp = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
      try { chmodSync(this.persistPath, 0o600); } catch { /* Windows: no-op-ish */ }
    } catch (e) {
      if (!this.saveWarned) {
        this.saveWarned = true;
        logger.warn({ path: this.persistPath, err: e instanceof Error ? e.message : String(e) },
          "could not persist sessions store; session resume across restarts is disabled");
      }
    }
  }

  // Unconditional save, for graceful shutdown.
  flush(): void {
    this.saveSoon(true);
  }

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
    this.saveSoon();
  }
}

export const DEFAULT_SESSION_KEY = "default";

export function deriveSessionKey(headers: {
  xMuseSession?: string | undefined;
  authorization?: string | undefined;
  xApiKey?: string | undefined;
}): string {
  if (headers.xMuseSession && headers.xMuseSession.trim().length > 0) {
    return `h:${headers.xMuseSession.trim()}`;
  }
  const credential = headers.authorization?.trim() ? headers.authorization : headers.xApiKey;
  if (credential && credential.trim().length > 0) {
    return `a:${createHash("sha256").update(credential).digest("hex").slice(0, 32)}`;
  }
  return DEFAULT_SESSION_KEY;
}

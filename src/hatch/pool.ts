import type { HatchClient } from "./client.js";

export interface PoolDeps {
  openClient: () => Promise<HatchClient>;
}

export interface ClientPool {
  withClient<T>(fn: (client: HatchClient) => Promise<T>): Promise<T>;
  reset(): Promise<void>;
  peek(): HatchClient | null;
}

// ponytail: serialized single-client pool. Multiplex (per-stream recvOne dispatch) is the upgrade path if throughput matters.
export function createClientPool(deps: PoolDeps): ClientPool {
  let current: HatchClient | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  async function withClient<T>(fn: (client: HatchClient) => Promise<T>): Promise<T> {
    const gate = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => { release = r; });
    try {
      await gate;
      if (current === null) current = await deps.openClient();
      try {
        return await fn(current);
      } catch (e) {
        await closeSafely(current);
        current = null;
        throw e;
      }
    } finally {
      release();
    }
  }

  async function reset(): Promise<void> {
    await closeSafely(current);
    current = null;
  }

  return { withClient, reset, peek: () => current };
}

async function closeSafely(c: HatchClient | null): Promise<void> {
  if (c === null) return;
  try { await c.close(); } catch { /* ignore */ }
}

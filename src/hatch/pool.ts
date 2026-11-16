import type { HatchClient } from "./client.js";

export interface PoolDeps {
  openClient: () => Promise<HatchClient>;
}

export interface ClientPool {
  withClient<T>(fn: (client: HatchClient) => Promise<T>): Promise<T>;
  reset(): Promise<void>;
  peek(): HatchClient | null;
}

// Multiplex pool: one HatchClient, N concurrent withClient callers. HatchClient's
// dispatcher routes events to per-stream queues so overlapping requests don't
// clobber each other. Only client-open is mutex'd (not request handling), so the
// first caller pays the ~500 ms handshake and the rest reuse it. On fn error we
// close + null the client; other in-flight callers will surface "closed" from
// recvOne and retry via the handler's bootstrap path.
export function createClientPool(deps: PoolDeps): ClientPool {
  let current: HatchClient | null = null;
  let opening: Promise<HatchClient> | null = null;

  async function getClient(): Promise<HatchClient> {
    if (current !== null) return current;
    if (opening !== null) return opening;
    opening = (async () => {
      try {
        const c = await deps.openClient();
        current = c;
        return c;
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  async function withClient<T>(fn: (client: HatchClient) => Promise<T>): Promise<T> {
    const c = await getClient();
    try {
      return await fn(c);
    } catch (e) {
      if (current === c) {
        await closeSafely(current);
        current = null;
      }
      throw e;
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

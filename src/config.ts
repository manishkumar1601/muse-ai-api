import { z } from "zod";

const Schema = z.object({
  MUSE_PROXY_HOST:         z.string().default("127.0.0.1"),
  MUSE_PROXY_PORT:         z.coerce.number().int().min(1).max(65535).default(8787),
  MUSE_PROXY_KEY:          z.string().optional(),
  MUSE_PROXY_MODEL:        z.string().default("muse-spark"),
  MUSE_SESSION_PATH:       z.string().default("./session.json"),
  MUSE_STORAGE_STATE_PATH: z.string().default("./storage_state.json"),
  MUSE_TZ:                 z.string().default("Asia/Calcutta"),
  LOG_LEVEL:               z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
});

export interface Config {
  host: string; port: number; proxyKey: string | undefined;
  model: string; sessionPath: string; storageStatePath: string;
  timezone: string; logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(env);
  // An empty / whitespace-only key means "no key" — never a key nobody can match.
  const proxyKey = parsed.MUSE_PROXY_KEY?.trim() ? parsed.MUSE_PROXY_KEY.trim() : undefined;
  return {
    host: parsed.MUSE_PROXY_HOST, port: parsed.MUSE_PROXY_PORT,
    proxyKey, model: parsed.MUSE_PROXY_MODEL,
    sessionPath: parsed.MUSE_SESSION_PATH, storageStatePath: parsed.MUSE_STORAGE_STATE_PATH,
    timezone: parsed.MUSE_TZ, logLevel: parsed.LOG_LEVEL,
  };
}

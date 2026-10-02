import { readFileSync } from "node:fs";

interface StorageStateCookie { name: string; value: string; domain: string; }
interface StorageState { cookies: StorageStateCookie[]; }

export function loadCookies(path: string): Record<string, string> {
  const data: StorageState = JSON.parse(readFileSync(path, "utf-8"));
  const out: Record<string, string> = {};
  for (const c of data.cookies) {
    if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") continue;
    const domain = c.domain.replace(/^\./, "");
    if (domain !== "muse.ai") continue;
    out[c.name] = c.value;
  }
  return out;
}

export function toCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ponytail: dynamic import defers cycletls/form-data load until getTls() is called;
// prevents the missing-dep crash when importing constants in unit tests.
import type { default as InitCycleTLS } from "cycletls";

// The fingerprint defaults to Windows Chrome (what the session cookies
// were minted with in the reference setup). Non-Windows users can match
// the browser they logged in with via env, without editing source:
//   MUSE_UA="Mozilla/5.0 (Macintosh; …) Chrome/…" MUSE_PLATFORM='"macOS"'
export const CHROME_UA =
  process.env["MUSE_UA"] ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
export const CHROME_SEC_CH_UA =
  '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"';
export const CHROME_SEC_CH_UA_PLATFORM = process.env["MUSE_PLATFORM"] ?? '"Windows"';
export const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";

export const SHARED_HEADERS: Record<string, string> = {
  "User-Agent": CHROME_UA,
  "sec-ch-ua": CHROME_SEC_CH_UA,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": CHROME_SEC_CH_UA_PLATFORM,
  "Origin": "https://muse.ai",
};

type CycleTLSClient = Awaited<ReturnType<typeof InitCycleTLS>>;

let instance: CycleTLSClient | null = null;
let initPromise: Promise<CycleTLSClient> | null = null;
let shuttingDown = false;

export async function getTls(): Promise<CycleTLSClient> {
  if (shuttingDown) throw new Error("cycletls is shutting down");
  if (instance) return instance;
  // Memoise the in-flight init: two concurrent first calls must not each
  // spawn a CycleTLS subprocess (one instance would leak, never exit()ed).
  if (!initPromise) {
    initPromise = (async () => {
      const { default: initCycleTLS } = await import("cycletls");
      instance = await (initCycleTLS as unknown as () => Promise<CycleTLSClient>)();
      return instance;
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

export async function shutdownTls(): Promise<void> {
  if (shuttingDown) return; // ponytail: idempotent guard
  shuttingDown = true;
  initPromise = null;
  if (instance) {
    const i = instance;
    instance = null;
    await (i as unknown as { exit(): Promise<void> }).exit();
  }
}

// Register process-wide signal handlers at module load.
// Skipped in test mode to avoid interfering with the test runner's own signal handling.
if (!process.env["NODE_ENV"]?.startsWith("test")) {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void shutdownTls().finally(() => process.exit(0));
    });
  }
  process.on("uncaughtException", (err) => {
    process.stderr.write(String(err) + "\n");
    void shutdownTls().finally(() => process.exit(1));
  });
}

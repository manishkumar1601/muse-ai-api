// One-shot: opens Chromium, waits for you to log in to muse.ai,
// mints session tokens through the browser (bypasses cycletls fingerprint
// issues that break `npm run bootstrap`), writes session.json. Done.
//
// Usage:  npx tsx scripts/login.ts
import { chromium } from "playwright";
import { writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const STATE_PATH = "storage_state.json";
const SESSION_PATH = "session.json";

const browser = await chromium.launch({ headless: false });
const ctx = existsSync(STATE_PATH)
  ? await browser.newContext({ storageState: STATE_PATH })
  : await browser.newContext();

const page = await ctx.newPage();
await page.goto("https://muse.ai/");

console.log("\n→ Log in to muse.ai in the opened browser.");
console.log("→ When you see the chat UI, come back here and press Enter.\n");
process.stdin.setRawMode?.(true);
process.stdin.resume();
await new Promise<void>((r) => process.stdin.once("data", () => r()));
process.stdin.setRawMode?.(false);
process.stdin.pause();

const cookies = await ctx.cookies();
if (!cookies.find((c) => c.name === "hatch_sess")) {
  console.error("hatch_sess cookie missing — not logged in. Try again.");
  await browser.close();
  process.exit(1);
}
await ctx.storageState({ path: STATE_PATH });
console.log(`✓ ${cookies.length} cookies → ${STATE_PATH}`);

console.log("→ Minting session tokens through the browser…");

// Give the page a moment to initialize __hatchEarlyGatewayRuntimeState.
await page.waitForFunction(
  () => !!(globalThis as unknown as { __hatchEarlyGatewayRuntimeState?: { activeGatewayUrl?: string } }).__hatchEarlyGatewayRuntimeState?.activeGatewayUrl,
  { timeout: 15_000 },
).catch(() => {});

type GatewayState = { activeGatewayUrl?: string; activeTargetKey?: string };
const gw: GatewayState | null = await page.evaluate(() => {
  const s = (globalThis as unknown as { __hatchEarlyGatewayRuntimeState?: GatewayState }).__hatchEarlyGatewayRuntimeState;
  return s ? { activeGatewayUrl: s.activeGatewayUrl, activeTargetKey: s.activeTargetKey } : null;
});
if (!gw?.activeGatewayUrl) {
  console.error("couldn't read activeGatewayUrl from the page — try again or wait longer after login");
  await browser.close();
  process.exit(1);
}
const gatewayUrl = gw.activeGatewayUrl;
// activeTargetKey is a JSON string like ["wss://<id>.metaaivm.com/", "<id>"]
let vmId: string;
try {
  vmId = (JSON.parse(gw.activeTargetKey ?? "[]") as string[])[1] ?? "";
} catch { vmId = ""; }
if (!vmId) {
  // Fallback: extract from gatewayUrl
  const m = gatewayUrl.match(/wss:\/\/([a-f0-9-]{36})\.metaaivm\.com/);
  vmId = m?.[1] ?? "";
}
if (!vmId) {
  console.error("couldn't resolve vm_id from gateway URL");
  await browser.close();
  process.exit(1);
}

// Mint tokens through the browser's own fetch (uses its session + JA3).
const tokens = await page.evaluate(async (args: { vmId: string; gatewayUrl: string }) => {
  const t = await fetch("/api/hatch/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vmAddress: args.gatewayUrl, vmName: args.vmId }), credentials: "include",
  }).then((r) => r.json());
  const n = await fetch("/api/hatch/noise-notary-token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vmName: args.vmId }), credentials: "include",
  }).then((r) => r.json());
  return { authToken: t.token as string, notaryToken: n.notaryToken as string };
}, { vmId, gatewayUrl });

if (!tokens.authToken || !tokens.notaryToken) {
  console.error("token endpoints returned empty — try again");
  await browser.close();
  process.exit(1);
}

const requestId = randomUUID();
const q = new URLSearchParams({
  vm_id: vmId,
  auth_token: tokens.authToken,
  notary_token: tokens.notaryToken,
  app_id: "hatch-web",
  request_id: requestId,
});
const session = {
  captured_at: new Date().toISOString(),
  vm_id: vmId,
  gateway_url: gatewayUrl,
  auth_token: tokens.authToken,
  notary_token: tokens.notaryToken,
  request_id: requestId,
  app_id: "hatch-web" as const,
  ws_url: `wss://hatch.metaaivm.com/v1/noise?${q.toString()}`,
  lb_host: "hatch.metaaivm.com" as const,
  noise_suite: "Noise_XX_25519_AESGCM_SHA256" as const,
};
writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));

await browser.close();
console.log(`✓ session.json written (vm_id=${vmId})`);
console.log("\n✓ Ready. Run `npm start` to launch the proxy.\n");

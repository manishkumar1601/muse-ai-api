// One-shot: opens Chromium, waits for you to log in to muse.ai,
// dumps storage_state.json, runs bootstrap, done.
//
// Usage:  npx tsx scripts/login.ts
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const STATE_PATH = "storage_state.json";

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
await browser.close();

console.log("\n→ Minting session tokens…");
const r = spawnSync("npm", ["run", "bootstrap"], { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("\n✓ Ready. Run `npm start` to launch the proxy.\n");

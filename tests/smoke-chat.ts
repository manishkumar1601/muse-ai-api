import { loadConfig } from "../src/config.js";
import { runChat, chatSessions } from "../src/server/handler.js";
import { shutdownTls } from "../src/hatch/tls.js";

const cfg = loadConfig();
try {
  const KEY_X = "h:X-proxy-session-" + Math.floor(Math.random() * 1e6);
  const KEY_Y = "h:Y-proxy-session-" + Math.floor(Math.random() * 1e6);
  console.log("session X id:", chatSessions.get(KEY_X).sessionId);
  console.log("session Y id:", chatSessions.get(KEY_Y).sessionId);

  console.log("[1/3] creating side chat X with marker SIDE-X-ONE…");
  const x1 = await runChat(cfg, "This is proxy side chat X — reply exactly: SIDE-X-OK", undefined, KEY_X);
  console.log("X1:", x1.replyText.slice(0, 200));

  console.log("[2/3] creating side chat Y with marker SIDE-Y-ONE…");
  const y1 = await runChat(cfg, "This is proxy side chat Y — reply exactly: SIDE-Y-OK", undefined, KEY_Y);
  console.log("Y1:", y1.replyText.slice(0, 200));

  console.log("[3/3] continuing side chat X; it must know its history, not Y's…");
  const x2 = await runChat(cfg, "What exact string did I ask you to reply with earlier?", undefined, KEY_X);
  console.log("X2:", x2.replyText.slice(0, 300));
} finally {
  await shutdownTls();
}

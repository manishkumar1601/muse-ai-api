import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { getTls, SHARED_HEADERS, CHROME_JA3 } from "../hatch/tls.js";
import { loadCookies, toCookieHeader } from "./cookies.js";
import { scrapeVmFromHtml } from "./scrape-vm.js";

export interface Session {
  captured_at: string;
  vm_id: string;
  gateway_url: string;
  auth_token: string;
  notary_token: string;
  request_id: string;
  app_id: "hatch-web";
  ws_url: string;
  lb_host: "hatch.metaaivm.com";
  noise_suite: "Noise_XX_25519_AESGCM_SHA256";
}

const BASE = "https://muse.ai";
const LB_HOST = "hatch.metaaivm.com" as const;
const NOISE_WS_PATH = "/v1/noise";
const APP_ID = "hatch-web" as const;

type TlsClient = Awaited<ReturnType<typeof getTls>>;
type TlsFn = (url: string, opts: unknown, method: string) => Promise<{ status: number; body: string }>;

async function postJson(
  tls: TlsClient,
  path: string,
  body: Record<string, unknown>,
  cookieHeader: string,
): Promise<Record<string, unknown>> {
  const resp = await (tls as unknown as TlsFn)(
    BASE + path,
    {
      ja3: CHROME_JA3,
      userAgent: SHARED_HEADERS["User-Agent"],
      headers: {
        ...SHARED_HEADERS,
        "Content-Type": "application/json",
        "Cookie": cookieHeader,
        "Referer": "https://muse.ai/",
      },
      body: JSON.stringify(body),
    },
    "POST",
  );
  if (resp.status < 200 || resp.status >= 300) {
    const b = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    throw new Error(`POST ${path} → ${resp.status}: ${b.slice(0, 200)}`);
  }
  return (typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body) as Record<string, unknown>;
}

async function getHtml(tls: TlsClient, path: string, cookieHeader: string): Promise<string> {
  const resp = await (tls as unknown as TlsFn)(
    BASE + path,
    {
      ja3: CHROME_JA3,
      userAgent: SHARED_HEADERS["User-Agent"],
      headers: {
        ...SHARED_HEADERS,
        "Cookie": cookieHeader,
        "Referer": "https://muse.ai/",
      },
    },
    "GET",
  );
  return resp.body;
}

export async function bootstrap(opts: {
  storageStatePath: string;
  sessionPath: string;
  vmId?: string;
  gatewayUrl?: string;
}): Promise<Session> {
  if (!existsSync(opts.storageStatePath)) {
    throw new Error(`storage_state.json not found at ${opts.storageStatePath}`);
  }

  const cookies = loadCookies(opts.storageStatePath);
  if (!cookies["hatch_sess"]) {
    throw new Error("hatch_sess cookie missing — log in to muse.ai and re-dump storage_state");
  }
  const cookieHeader = toCookieHeader(cookies);
  const tls = await getTls();

  let vmId = opts.vmId;
  let gatewayUrl = opts.gatewayUrl;

  if (!vmId || !gatewayUrl) {
    try {
      const lease = await postJson(tls, "/api/hatch/lease-vm", { vmType: "standard" }, cookieHeader);
      if (lease["status"] === "assigned"
          && typeof lease["gatewayUrl"] === "string"
          && typeof lease["vmName"] === "string") {
        gatewayUrl = lease["gatewayUrl"];
        vmId = lease["vmName"];
      }
    } catch {
      // 403 expected if VM already assigned — fall through to HTML scrape
    }

    if (!vmId || !gatewayUrl) {
      const html = await getHtml(tls, "/", cookieHeader);
      const scraped = scrapeVmFromHtml(html);
      if (!scraped) {
        throw new Error("could not resolve vm_id — lease failed and HTML has no activeGatewayUrl");
      }
      vmId = scraped.vmId;
      gatewayUrl = scraped.gatewayUrl;
    }
  }

  await postJson(tls, "/api/hatch/vm/wake", { vm_id: vmId, retry_count: 0 }, cookieHeader);

  const tokenResp = await postJson(tls, "/api/hatch/token", { vmAddress: gatewayUrl, vmName: vmId }, cookieHeader);
  if (typeof tokenResp["token"] !== "string" || !tokenResp["token"].trim()) {
    throw new Error("token response missing or empty 'token'");
  }
  const authToken = tokenResp["token"];

  const notaryResp = await postJson(tls, "/api/hatch/noise-notary-token", { vmName: vmId }, cookieHeader);
  if (typeof notaryResp["notaryToken"] !== "string" || !notaryResp["notaryToken"].trim()) {
    throw new Error("notary response missing or empty 'notaryToken'");
  }
  const notaryToken = notaryResp["notaryToken"].trim();

  const requestId = randomUUID();
  const q = new URLSearchParams({
    vm_id: vmId,
    auth_token: authToken,
    notary_token: notaryToken,
    app_id: APP_ID,
    request_id: requestId,
  });
  const wsUrl = `wss://${LB_HOST}${NOISE_WS_PATH}?${q.toString()}`;

  const session: Session = {
    captured_at: new Date().toISOString(),
    vm_id: vmId,
    gateway_url: gatewayUrl,
    auth_token: authToken,
    notary_token: notaryToken,
    request_id: requestId,
    app_id: APP_ID,
    ws_url: wsUrl,
    lb_host: LB_HOST,
    noise_suite: "Noise_XX_25519_AESGCM_SHA256",
  };

  writeFileSync(opts.sessionPath, JSON.stringify(session, null, 2), "utf-8");
  return session;
}

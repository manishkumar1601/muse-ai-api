const RE = /activeGatewayUrl"\s*:\s*"(wss:\/\/([a-f0-9-]{36})\.metaaivm\.com\/?)"/;

export function scrapeVmFromHtml(html: string): { vmId: string; gatewayUrl: string } | null {
  const m = html.match(RE);
  if (!m) return null;
  return { vmId: m[2]!, gatewayUrl: m[1]! };
}

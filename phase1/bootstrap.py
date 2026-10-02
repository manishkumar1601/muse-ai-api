"""Phase 1 bootstrap: muse.ai (Hatch) session cookies -> everything needed to open the Noise WebSocket.

Produces session.json with vm_id, gateway_url, auth_token, notary_token, and the fully-built ws_url.
No crypto yet; Noise handshake happens in Phase 2.

Usage:
    python bootstrap.py                       # defaults: storage_state.json -> session.json
    python bootstrap.py --vm-id <uuid>        # skip the lease call if you already have a vm_id
    python bootstrap.py --verbose             # dump every request + response body
"""

import argparse
import json
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse, quote

# ponytail: `requests` + stdlib ssl gets 403'd — muse.ai fingerprints TLS/HTTP2 (likely
# Cloudflare bot-management). curl_cffi impersonates real Chrome's TLS+H2 and sails through.
from curl_cffi import requests  # type: ignore


BASE = "https://muse.ai"
LB_HOST = "hatch.metaaivm.com"
NOISE_WS_PATH = "/v1/noise"
APP_ID = "hatch-web"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)


def load_cookies(storage_state_path: Path) -> dict[str, str]:
    data = json.loads(storage_state_path.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for c in data.get("cookies", []):
        domain = c["domain"].lstrip(".")
        if "muse.ai" not in domain:
            continue
        out[c["name"]] = c["value"]
    return out


def session_with(cookies: dict[str, str]) -> requests.Session:
    # curl_cffi Session: impersonate gives us Chrome TLS + H2 fingerprint, but its DEFAULT
    # UA/sec-ch-ua headers are macOS Chrome 150 — Hatch 403s because the cookie was issued
    # to Windows Chrome 154. Override the headers to match the issuing browser exactly.
    s = requests.Session(impersonate="chrome")
    for name, value in cookies.items():
        s.cookies.set(name, value, domain=".muse.ai")
    # ponytail: override every UA-identifying header so it matches the browser that
    # minted the session cookie. "fetch" semantics (not "navigate") because these are
    # XHR-style POSTs from JS, not top-level navigations.
    s.headers.update({
        "User-Agent": UA,
        "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Origin": BASE,
        "Referer": BASE + "/",
        "Accept": "*/*",
        "Content-Type": "application/json",
    })
    return s


def post(s: requests.Session, path: str, body: dict, verbose: bool) -> dict:
    url = BASE + path
    if verbose:
        print(f"  POST {path}  body={json.dumps(body)}", file=sys.stderr)
    r = s.post(url, json=body, timeout=15)
    text = r.text
    if verbose:
        preview = text if len(text) < 600 else text[:600] + f"... [{len(text)} bytes]"
        print(f"  <- {r.status_code}  {preview}", file=sys.stderr)
    if not r.ok:
        raise RuntimeError(f"{path} failed: HTTP {r.status_code}  body={text[:400]}")
    try:
        return r.json()
    except json.JSONDecodeError:
        return {"_raw": text}


def extract_vm_id(gateway_url: str) -> str | None:
    """Hatch gateway URL format: wss://<vm_id>.metaaivm.com/ — pull the UUID subdomain."""
    try:
        host = urlparse(gateway_url).hostname or ""
    except ValueError:
        return None
    if not host.endswith(".metaaivm.com"):
        return None
    prefix = host[: -len(".metaaivm.com")]
    return prefix if 30 <= len(prefix) <= 80 else None


_GATEWAY_URL_RE = re.compile(r'activeGatewayUrl"\s*:\s*"(wss://[^"]+?\.metaaivm\.com/)"')


def resolve_vm_from_html(s: requests.Session) -> tuple[str, str] | None:
    """Fetch https://muse.ai/ and parse activeGatewayUrl from the SSR'd Hatch state.
    Used when --vm-id isn't passed and lease-vm 403s (common once a VM is already assigned)."""
    r = s.get(BASE + "/", timeout=15)
    if not r.ok:
        return None
    m = _GATEWAY_URL_RE.search(r.text)
    if not m:
        return None
    gateway_url = m.group(1)
    vm_id = extract_vm_id(gateway_url)
    return (vm_id, gateway_url) if vm_id else None


def build_ws_url(vm_id: str, auth_token: str, notary_token: str, request_id: str) -> str:
    params = [
        f"vm_id={quote(vm_id, safe='')}",
        f"auth_token={quote(auth_token, safe='')}",
        f"notary_token={quote(notary_token, safe='')}",
        f"app_id={quote(APP_ID, safe='')}",
        f"request_id={quote(request_id, safe='')}",
    ]
    return f"wss://{LB_HOST}{NOISE_WS_PATH}?{'&'.join(params)}"


def run(args) -> int:
    storage_state = Path(args.storage_state)
    if not storage_state.exists():
        print(f"storage_state.json not found at {storage_state}", file=sys.stderr)
        print("Re-dump it from an authenticated Playwright session, e.g.:", file=sys.stderr)
        print("  await context.storageState({ path: 'storage_state.json' })", file=sys.stderr)
        return 2

    cookies = load_cookies(storage_state)
    if "hatch_sess" not in cookies:
        print("warning: no 'hatch_sess' cookie found — session will almost certainly fail", file=sys.stderr)
    print(f"loaded {len(cookies)} muse.ai cookies: {sorted(cookies.keys())}", file=sys.stderr)

    s = session_with(cookies)

    # Step 1 — resolve vm_id + gateway_url
    if args.vm_id and args.gateway_url:
        vm_id = args.vm_id.strip()
        gateway_url = args.gateway_url.strip()
        print(f"[1/4] vm resolved from flags: {vm_id}", file=sys.stderr)
    else:
        print("[1/4] resolving vm — try lease, fall back to HTML scrape", file=sys.stderr)
        gateway_url: str | None = None
        vm_id: str = ""
        try:
            lease = post(s, "/api/hatch/lease-vm", {"vmType": args.vm_type}, args.verbose)
            if lease.get("status") == "assigned":
                gateway_url = lease["gatewayUrl"]
                vm_id = lease.get("vmName", "").strip() or (extract_vm_id(gateway_url) or "")
        except RuntimeError as e:
            # 403 is expected once a VM is already assigned to this account; HTML has it
            print(f"  lease unavailable ({e}); scraping HTML for existing vm_id", file=sys.stderr)
        if not vm_id:
            resolved = resolve_vm_from_html(s)
            if resolved is None:
                raise RuntimeError(
                    "could not resolve vm_id: lease-vm failed AND activeGatewayUrl not in HTML. "
                    "Pass --vm-id and --gateway-url manually (grab from DevTools: "
                    "`window.__hatchEarlyGatewayRuntimeState.activeGatewayUrl`)."
                )
            vm_id, gateway_url = resolved
            print(f"  scraped vm_id={vm_id}", file=sys.stderr)

    # Step 2 — wake
    print(f"[2/4] vm/wake  vm_id={vm_id}", file=sys.stderr)
    post(s, "/api/hatch/vm/wake", {"vm_id": vm_id, "retry_count": 0}, args.verbose)

    # Step 3 — token
    print(f"[3/4] token  vmAddress={gateway_url}", file=sys.stderr)
    tok = post(
        s,
        "/api/hatch/token",
        {"vmAddress": gateway_url, "vmName": vm_id},
        args.verbose,
    )
    if "token" not in tok:
        raise RuntimeError(f"token response missing 'token' field: {tok}")
    auth_token = tok["token"]

    # Step 4 — noise notary token
    print(f"[4/4] noise-notary-token  vmName={vm_id}", file=sys.stderr)
    notary = post(s, "/api/hatch/noise-notary-token", {"vmName": vm_id}, args.verbose)
    if "notaryToken" not in notary:
        raise RuntimeError(f"notary response missing 'notaryToken': {notary}")
    notary_token = notary["notaryToken"].strip()

    request_id = str(uuid.uuid4())
    ws_url = build_ws_url(vm_id, auth_token, notary_token, request_id)

    out_path = Path(args.out)
    session = {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "vm_id": vm_id,
        "gateway_url": gateway_url,
        "auth_token": auth_token,
        "notary_token": notary_token,
        "request_id": request_id,
        "app_id": APP_ID,
        "ws_url": ws_url,
        "lb_host": LB_HOST,
        "noise_suite": "Noise_XX_25519_AESGCM_SHA256",
    }
    out_path.write_text(json.dumps(session, indent=2), encoding="utf-8")
    print(f"\nOK — wrote {out_path}", file=sys.stderr)
    print(f"  vm_id       = {vm_id}", file=sys.stderr)
    print(f"  gateway_url = {gateway_url}", file=sys.stderr)
    print(f"  auth_token  = {auth_token[:40]}... ({len(auth_token)} chars)", file=sys.stderr)
    print(f"  notary      = {notary_token[:40]}... ({len(notary_token)} chars)", file=sys.stderr)
    print(f"  ws_url      = {ws_url[:120]}...", file=sys.stderr)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--storage-state", default="storage_state.json")
    ap.add_argument("--out", default="session.json")
    ap.add_argument("--vm-type", default="standard")
    ap.add_argument("--vm-id", help="skip lease, use this vm_id directly (requires --gateway-url)")
    ap.add_argument("--gateway-url", help="gateway URL to pair with --vm-id")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--self-check", action="store_true", help="run offline sanity tests and exit")
    args = ap.parse_args()

    if args.self_check:
        _demo()
        return

    # ponytail: no retry loop. If anything fails, rerun — tokens are cheap, cookies may be stale.
    try:
        sys.exit(run(args))
    except RuntimeError as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        sys.exit(1)


def _demo():
    """Self-check: build_ws_url + extract_vm_id are the only pieces of pure logic worth asserting on."""
    url = build_ws_url(
        "3574599d-879f-4ffe-b294-61b50ba60c1a",
        "jwt.abc",
        "endorsement.v1.xyz",
        "req-1",
    )
    assert url.startswith("wss://hatch.metaaivm.com/v1/noise?"), url
    assert "vm_id=3574599d-879f-4ffe-b294-61b50ba60c1a" in url
    assert "auth_token=jwt.abc" in url
    assert "notary_token=endorsement.v1.xyz" in url
    assert "app_id=hatch-web" in url
    assert "request_id=req-1" in url
    assert extract_vm_id("wss://3574599d-879f-4ffe-b294-61b50ba60c1a.metaaivm.com/") == "3574599d-879f-4ffe-b294-61b50ba60c1a"
    assert extract_vm_id("wss://hatch.metaaivm.com/v1/noise") is None
    assert extract_vm_id("not a url at all") is None
    print("self-check: OK")


if __name__ == "__main__":
    main()

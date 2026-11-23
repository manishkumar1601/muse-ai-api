# Point Codex CLI at the local muse proxy WITHOUT touching your normal
# Codex login. Uses a dedicated CODEX_HOME (%USERPROFILE%\.codex-muse) for
# THIS shell only -- your real ~/.codex (and its logged-in account) is
# never read or modified. Close the shell to revert.
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 ANSI parsing).
#
# Usage:
#   . .\scripts\use-with-codex.ps1               # dot-source, then run: codex
#   . .\scripts\use-with-codex.ps1 my-project    # dedicated side chat on muse.ai;
#                                                # reuse the same name later to RESUME it
# Current Codex only speaks the Responses API, so the generated config
# uses wire_api = "responses" against the proxy's /v1/responses endpoint.
# Codex cannot send an X-Muse-Session header, so the session is carried
# in the API key token instead (proxy-<name>); the proxy derives the side
# chat from it. Same name = same chat, every time.

param([string]$Session = "")

# Session names become API-token parts downstream; keep them to a safe
# charset so they can never corrupt a header or a config file.
if ($Session -and $Session -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Host "Session name '$Session' is not allowed - use only letters, digits, dot, underscore and hyphen." -ForegroundColor Red
  return
}

$port  = if ($env:MUSE_PROXY_PORT)  { $env:MUSE_PROXY_PORT }  else { "8787" }
$model = if ($env:MUSE_PROXY_MODEL) { $env:MUSE_PROXY_MODEL } else { "muse-spark" }

$codexHome = Join-Path $HOME ".codex-muse"
if (-not (Test-Path $codexHome)) { New-Item -ItemType Directory -Path $codexHome | Out-Null }
$configPath = Join-Path $codexHome "config.toml"

if (-not (Test-Path $configPath)) {
  $toml = @"
model = "$model"
model_provider = "muse"

[model_providers.muse]
name = "Muse Proxy"
base_url = "http://127.0.0.1:$port/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
"@
  Set-Content -Path $configPath -Value $toml -Encoding ASCII
  Write-Host "Created $configPath"
} else {
  $cfgText = Get-Content $configPath -Raw
  if ($cfgText -notmatch 'model_providers\.muse') {
    Write-Host "WARNING: $configPath exists but has no [model_providers.muse] block." -ForegroundColor Yellow
    Write-Host "Add the provider block from README section 5a, or delete the file and re-run this script."
  } elseif ($cfgText -notmatch 'wire_api\s*=\s*"responses"') {
    Write-Host "WARNING: $configPath does not set wire_api = `"responses`" - current Codex will refuse to start." -ForegroundColor Yellow
    Write-Host "Fix the provider block (see README section 5a), or delete the file and re-run this script."
  } elseif ($cfgText -notmatch [regex]::Escape("127.0.0.1:$port/v1")) {
    Write-Host "WARNING: $configPath base_url does not point at port $port (MUSE_PROXY_PORT)." -ForegroundColor Yellow
    Write-Host "If your proxy runs on a different port this is fine; otherwise update base_url or delete the file and re-run."
  }
}

$env:CODEX_HOME = $codexHome
if ($Session) {
  $env:OPENAI_API_KEY = "proxy-$Session"
  Write-Host "Codex -> muse proxy (side chat: $Session). Just run: codex"
  Write-Host "  Reuse the same session name in a new shell to resume this chat."
} else {
  $env:OPENAI_API_KEY = "proxy"
  Write-Host "Codex -> muse proxy (default side chat). Just run: codex"
}
Write-Host "  Plain 'codex' in any other shell still uses your logged-in Codex account."

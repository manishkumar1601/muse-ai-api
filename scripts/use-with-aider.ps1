# Point Aider at the local muse proxy for THIS shell only.
# Aider cannot send an X-Muse-Session header, so the session is carried
# in the API key token (proxy-<name>); the proxy derives the side chat
# from it. Same name = same chat, every time. Close the shell to revert.
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 ANSI parsing).
#
# Usage:
#   . .\scripts\use-with-aider.ps1               # dot-source, then run:
#                                                #   aider --model openai/muse-spark
#   . .\scripts\use-with-aider.ps1 my-project    # dedicated side chat; reuse the
#                                                # same name later to RESUME it

param([string]$Session = "")

if ($Session -and $Session -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Host "Session name '$Session' is not allowed - use only letters, digits, dot, underscore and hyphen." -ForegroundColor Red
  return
}

$port  = if ($env:MUSE_PROXY_PORT)  { $env:MUSE_PROXY_PORT }  else { "8787" }
$model = if ($env:MUSE_PROXY_MODEL) { $env:MUSE_PROXY_MODEL } else { "muse-spark" }

$env:OPENAI_API_BASE = "http://127.0.0.1:$port/v1"
$env:OPENAI_BASE_URL = "http://127.0.0.1:$port/v1"
if ($Session) {
  $env:OPENAI_API_KEY = "proxy-$Session"
  Write-Host "Aider -> muse proxy (side chat: $Session). Run: aider --model openai/$model"
  Write-Host "  Reuse the same session name in a new shell to resume this chat."
} else {
  $env:OPENAI_API_KEY = "proxy"
  Write-Host "Aider -> muse proxy (default side chat). Run: aider --model openai/$model"
}
Write-Host "  Close this shell to revert to your normal Aider setup."

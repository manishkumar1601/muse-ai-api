# Point any OpenAI-compatible client (Continue.dev, Cline, OpenAI SDKs,
# custom tools) at the local muse proxy for THIS shell only.
# Close the shell to revert.
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 ANSI parsing).
#
# Usage:
#   . .\scripts\use-with-openai.ps1               # dot-source, then run your client
#   . .\scripts\use-with-openai.ps1 my-project    # dedicated side chat on muse.ai;
#                                                 # reuse the same name later to RESUME it

param([string]$Session = "")

# Session names are embedded in a JSON header string; keep them to a
# safe charset so the JSON can never be malformed.
if ($Session -and $Session -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Host "Session name '$Session' is not allowed - use only letters, digits, dot, underscore and hyphen." -ForegroundColor Red
  return
}

$port  = if ($env:MUSE_PROXY_PORT)  { $env:MUSE_PROXY_PORT }  else { "8787" }
$model = if ($env:MUSE_PROXY_MODEL) { $env:MUSE_PROXY_MODEL } else { "muse-spark" }

$env:OPENAI_BASE_URL = "http://127.0.0.1:$port/v1"
$env:OPENAI_MODEL    = $model
if ($Session) {
  # Clients that honour default headers route by the header; clients that
  # only send the key route by token derivation. Either way the same
  # client + same session name lands on the same chat every time.
  $env:OPENAI_API_KEY = "proxy-$Session"
  $env:OPENAI_DEFAULT_HEADERS = "{`"X-Muse-Session`":`"$Session`"}"
  Write-Host "OpenAI clients -> muse proxy (side chat: $Session)."
  Write-Host "  Reuse the same session name in a new shell to resume this chat."
} else {
  $env:OPENAI_API_KEY = "proxy"
  Remove-Item Env:OPENAI_DEFAULT_HEADERS -ErrorAction SilentlyContinue
  Write-Host "OpenAI clients -> muse proxy (default side chat)."
}
Write-Host "  Close this shell to revert."

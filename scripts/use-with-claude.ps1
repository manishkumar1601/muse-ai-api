# Point Claude Code at the local muse proxy for THIS shell only.
# Global ~/.claude/.credentials.json is untouched -- close the shell to revert.
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 files
# without a BOM as ANSI, and UTF-8 punctuation (em-dashes, checkmarks) can
# decode into quote characters that break the parser.
#
# Usage:
#   . .\scripts\use-with-claude.ps1               # dot-source, then run `claude`
#   . .\scripts\use-with-claude.ps1 my-project    # dedicated side chat on muse.ai

param([string]$Session = "")

# Respect a customised proxy port/model if the user set them.
$port  = if ($env:MUSE_PROXY_PORT)  { $env:MUSE_PROXY_PORT }  else { "8787" }
$model = if ($env:MUSE_PROXY_MODEL) { $env:MUSE_PROXY_MODEL } else { "muse-spark" }

$env:ANTHROPIC_BASE_URL             = "http://127.0.0.1:$port"
$env:ANTHROPIC_AUTH_TOKEN           = "proxy"
$env:ANTHROPIC_MODEL                = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $model
$env:CLAUDE_CODE_SUBAGENT_MODEL     = $model

if ($Session) {
  $env:ANTHROPIC_CUSTOM_HEADERS = "X-Muse-Session: $Session"
  Write-Host "Claude Code -> muse proxy (side chat: $Session). Just run: claude" -ForegroundColor Green
} else {
  # Clear any side-chat header left over from a previous dot-source in
  # this shell -- otherwise we'd claim "main chat" while still routing
  # to the old side chat.
  Remove-Item Env:ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue
  Write-Host "Claude Code -> muse proxy (token-keyed side chat; no X-Muse-Session). Just run: claude" -ForegroundColor Green
}
Write-Host "  Close this shell to revert to your global Claude account."

# Point Claude Code at the local muse proxy for THIS shell only.
# Global ~/.claude/.credentials.json is untouched — close the shell to revert.
#
# Usage:
#   . .\scripts\use-with-claude.ps1               # dot-source, then run `claude`
#   . .\scripts\use-with-claude.ps1 my-project    # dedicated side chat on muse.ai

param([string]$Session = "")

$env:ANTHROPIC_BASE_URL             = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN           = "anything"
$env:ANTHROPIC_MODEL                = "muse-spark"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = "muse-spark"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "muse-spark"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = "muse-spark"
$env:CLAUDE_CODE_SUBAGENT_MODEL     = "muse-spark"

if ($Session) {
  $env:ANTHROPIC_CUSTOM_HEADERS = "X-Muse-Session: $Session"
  Write-Host "✓ Claude Code -> muse proxy (side chat: $Session). Just run: claude" -ForegroundColor Green
} else {
  Write-Host "✓ Claude Code -> muse proxy (main chat). Just run: claude" -ForegroundColor Green
}
Write-Host "  Close this shell to revert to your global Claude account."

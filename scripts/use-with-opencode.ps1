# Point OpenCode at the local muse proxy for THIS shell only, via a
# generated config in %USERPROFILE%\.muse-proxy\opencode.json passed
# through OPENCODE_CONFIG. Your global OpenCode config is untouched.
# The generated file is proxy-owned and REGENERATED on every run.
# Close the shell to revert.
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 ANSI parsing).
#
# Usage:
#   . .\scripts\use-with-opencode.ps1               # dot-source, then run: opencode
#   . .\scripts\use-with-opencode.ps1 my-project    # dedicated side chat on muse.ai;
#                                                   # reuse the same name later to RESUME it

param([string]$Session = "")

# Session names are embedded in the generated JSON config; keep them to
# a safe charset (also keeps resume parity with the .sh twin).
if ($Session -and $Session -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Host "Session name '$Session' is not allowed - use only letters, digits, dot, underscore and hyphen." -ForegroundColor Red
  return
}

$port  = if ($env:MUSE_PROXY_PORT)  { $env:MUSE_PROXY_PORT }  else { "8787" }
$model = if ($env:MUSE_PROXY_MODEL) { $env:MUSE_PROXY_MODEL } else { "muse-spark" }

$options = [ordered]@{
  baseURL = "http://127.0.0.1:$port/v1"
  apiKey  = "proxy"
}
if ($Session) { $options["headers"] = @{ "X-Muse-Session" = $Session } }

$config = [ordered]@{
  "`$schema" = "https://opencode.ai/config.json"
  model      = "muse/$model"
  provider   = @{
    muse = @{
      npm     = "@ai-sdk/openai-compatible"
      name    = "Muse Proxy"
      options = $options
      models  = @{ $model = @{ name = "Muse Spark (proxy)" } }
    }
  }
}

$dir = Join-Path $HOME ".muse-proxy"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$configPath = Join-Path $dir "opencode.json"
($config | ConvertTo-Json -Depth 8) | Set-Content -Path $configPath -Encoding ASCII

$env:OPENCODE_CONFIG = $configPath
Write-Host "Generated $configPath (proxy-owned; regenerated on every run - do not hand-edit)."
if ($Session) {
  Write-Host "OpenCode -> muse proxy (side chat: $Session). Just run: opencode"
  Write-Host "  Reuse the same session name in a new shell to resume this chat."
} else {
  Write-Host "OpenCode -> muse proxy (default side chat). Just run: opencode"
}
Write-Host "  Close this shell to revert to your normal OpenCode setup."

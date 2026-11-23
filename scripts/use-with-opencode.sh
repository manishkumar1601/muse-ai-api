# Point OpenCode at the local muse proxy for THIS shell only, via a
# generated config in $HOME/.muse-proxy/opencode.json passed through
# OPENCODE_CONFIG. Your global OpenCode config is untouched.
# The generated file is proxy-owned and REGENERATED on every run.
# Close the shell to revert.
#
# Usage (must be SOURCED, not executed):
#   . ./scripts/use-with-opencode.sh               # then run: opencode
#   . ./scripts/use-with-opencode.sh my-project    # dedicated side chat on muse.ai;
#                                                  # reuse the same name later to RESUME it
# Session names: letters, digits, dot, underscore, hyphen only (the name is
# embedded in the generated JSON, so anything else is rejected up front).

_muse_sourced=1
if [ -n "${ZSH_VERSION:-}" ]; then
  case ":${ZSH_EVAL_CONTEXT:-}:" in *":file:"*) : ;; *) _muse_sourced=0 ;; esac
elif ! (return 0 2>/dev/null); then
  _muse_sourced=0
fi
_muse_session="${1:-}"
_muse_valid=1
case "$_muse_session" in *[!A-Za-z0-9._-]*) _muse_valid=0 ;; esac
case "${MUSE_PROXY_MODEL:-}" in *[!A-Za-z0-9._-]*) _muse_valid=0 ;; esac

if [ "$_muse_sourced" != "1" ]; then
  echo "Please source this script:  . ./scripts/use-with-opencode.sh [session-name]" >&2
elif [ "$_muse_valid" != "1" ]; then
  echo "Session/model name is not allowed - use only letters, digits, dot, underscore and hyphen." >&2
else
  _muse_port="${MUSE_PROXY_PORT:-8787}"
  _muse_model="${MUSE_PROXY_MODEL:-muse-spark}"
  _muse_dir="$HOME/.muse-proxy"
  _muse_config="$_muse_dir/opencode.json"

  mkdir -p "$_muse_dir"
  if [ -n "$_muse_session" ]; then
    _muse_headers=",
      \"headers\": { \"X-Muse-Session\": \"$_muse_session\" }"
  else
    _muse_headers=""
  fi
  cat > "$_muse_config" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "muse/$_muse_model",
  "provider": {
    "muse": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Muse Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:$_muse_port/v1",
        "apiKey": "proxy"$_muse_headers
      },
      "models": {
        "$_muse_model": { "name": "Muse Spark (proxy)" }
      }
    }
  }
}
EOF
  export OPENCODE_CONFIG="$_muse_config"
  if [ -n "$_muse_session" ]; then
    echo "OpenCode -> muse proxy (side chat: $_muse_session). Just run: opencode"
    echo "  Reuse the same session name in a new shell to resume this chat."
  else
    echo "OpenCode -> muse proxy (default side chat). Just run: opencode"
  fi
  echo "  Close this shell to revert to your normal OpenCode setup."
  unset _muse_port _muse_model _muse_dir _muse_config _muse_headers
fi
unset _muse_sourced _muse_session _muse_valid

# Point Codex CLI at the local muse proxy WITHOUT touching your normal
# Codex login. Uses a dedicated CODEX_HOME ($HOME/.codex-muse) for THIS
# shell only -- your real ~/.codex (and its logged-in account) is never
# read or modified. Close the shell to revert.
#
# Usage (must be SOURCED, not executed):
#   . ./scripts/use-with-codex.sh               # then run: codex
#   . ./scripts/use-with-codex.sh my-project    # dedicated side chat on muse.ai;
#                                               # reuse the same name later to RESUME it
# Session names: letters, digits, dot, underscore, hyphen only.
# Current Codex only speaks the Responses API, so the generated config
# uses wire_api = "responses" against the proxy's /v1/responses endpoint.
# Codex cannot send an X-Muse-Session header, so the session is carried
# in the API key token instead (proxy-<name>); the proxy derives the side
# chat from it. Same name = same chat, every time.

_muse_sourced=1
if [ -n "${ZSH_VERSION:-}" ]; then
  case ":${ZSH_EVAL_CONTEXT:-}:" in *":file:"*) : ;; *) _muse_sourced=0 ;; esac
elif ! (return 0 2>/dev/null); then
  _muse_sourced=0
fi
_muse_session="${1:-}"
_muse_valid=1
case "$_muse_session" in *[!A-Za-z0-9._-]*) _muse_valid=0 ;; esac

if [ "$_muse_sourced" != "1" ]; then
  echo "Please source this script:  . ./scripts/use-with-codex.sh [session-name]" >&2
elif [ "$_muse_valid" != "1" ]; then
  echo "Session name '$_muse_session' is not allowed - use only letters, digits, dot, underscore and hyphen." >&2
else
  _muse_port="${MUSE_PROXY_PORT:-8787}"
  _muse_model="${MUSE_PROXY_MODEL:-muse-spark}"
  _muse_codex_home="$HOME/.codex-muse"
  _muse_config="$_muse_codex_home/config.toml"

  mkdir -p "$_muse_codex_home"
  if [ ! -f "$_muse_config" ]; then
    cat > "$_muse_config" <<EOF
model = "$_muse_model"
model_provider = "muse"

[model_providers.muse]
name = "Muse Proxy"
base_url = "http://127.0.0.1:$_muse_port/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
EOF
    echo "Created $_muse_config"
  elif ! grep -q "model_providers\.muse" "$_muse_config"; then
    echo "WARNING: $_muse_config exists but has no [model_providers.muse] block." >&2
    echo "Add the provider block from README section 5a, or delete the file and re-run this script." >&2
  elif ! grep -q 'wire_api[[:space:]]*=[[:space:]]*"responses"' "$_muse_config"; then
    echo "WARNING: $_muse_config does not set wire_api = \"responses\" - current Codex will refuse to start." >&2
    echo "Fix the provider block (see README section 5a), or delete the file and re-run this script." >&2
  elif ! grep -q "127.0.0.1:$_muse_port/v1" "$_muse_config"; then
    echo "WARNING: $_muse_config base_url does not point at port $_muse_port (MUSE_PROXY_PORT)." >&2
    echo "If your proxy runs on a different port this is fine; otherwise update base_url or delete the file and re-run." >&2
  fi

  export CODEX_HOME="$_muse_codex_home"
  if [ -n "$_muse_session" ]; then
    export OPENAI_API_KEY="proxy-$_muse_session"
    echo "Codex -> muse proxy (side chat: $_muse_session). Just run: codex"
    echo "  Reuse the same session name in a new shell to resume this chat."
  else
    export OPENAI_API_KEY="proxy"
    echo "Codex -> muse proxy (default side chat). Just run: codex"
  fi
  echo "  Plain 'codex' in any other shell still uses your logged-in Codex account."
  unset _muse_port _muse_model _muse_codex_home _muse_config
fi
unset _muse_sourced _muse_session _muse_valid

# Point Aider at the local muse proxy for THIS shell only.
# Aider cannot send an X-Muse-Session header, so the session is carried
# in the API key token (proxy-<name>); the proxy derives the side chat
# from it. Same name = same chat, every time. Close the shell to revert.
#
# Usage (must be SOURCED, not executed):
#   . ./scripts/use-with-aider.sh               # then run:
#                                               #   aider --model openai/muse-spark
#   . ./scripts/use-with-aider.sh my-project    # dedicated side chat; reuse the
#                                               # same name later to RESUME it
# Session names: letters, digits, dot, underscore, hyphen only.

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
  echo "Please source this script:  . ./scripts/use-with-aider.sh [session-name]" >&2
elif [ "$_muse_valid" != "1" ]; then
  echo "Session name '$_muse_session' is not allowed - use only letters, digits, dot, underscore and hyphen." >&2
else
  _muse_port="${MUSE_PROXY_PORT:-8787}"
  _muse_model="${MUSE_PROXY_MODEL:-muse-spark}"

  export OPENAI_API_BASE="http://127.0.0.1:$_muse_port/v1"
  export OPENAI_BASE_URL="http://127.0.0.1:$_muse_port/v1"
  if [ -n "$_muse_session" ]; then
    export OPENAI_API_KEY="proxy-$_muse_session"
    echo "Aider -> muse proxy (side chat: $_muse_session). Run: aider --model openai/$_muse_model"
    echo "  Reuse the same session name in a new shell to resume this chat."
  else
    export OPENAI_API_KEY="proxy"
    echo "Aider -> muse proxy (default side chat). Run: aider --model openai/$_muse_model"
  fi
  echo "  Close this shell to revert to your normal Aider setup."
  unset _muse_port _muse_model
fi
unset _muse_sourced _muse_session _muse_valid

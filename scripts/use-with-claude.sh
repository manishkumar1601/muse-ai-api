# Point Claude Code at the local muse proxy for THIS shell only.
# Global ~/.claude config/credentials are untouched -- close the shell to revert.
#
# Usage (must be SOURCED, not executed):
#   . ./scripts/use-with-claude.sh               # then run: claude
#   . ./scripts/use-with-claude.sh my-project    # dedicated side chat on muse.ai;
#                                                # reuse the same name later to RESUME it
# Session names: letters, digits, dot, underscore, hyphen only.

# Sourced-or-executed detection. The (return) test works in bash; in zsh
# a top-level return in an EXECUTED script is legal, so check the eval
# context there instead (":file:" is present only when sourcing).
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
  echo "Please source this script:  . ./scripts/use-with-claude.sh [session-name]" >&2
elif [ "$_muse_valid" != "1" ]; then
  echo "Session name '$_muse_session' is not allowed - use only letters, digits, dot, underscore and hyphen." >&2
else
  _muse_port="${MUSE_PROXY_PORT:-8787}"
  _muse_model="${MUSE_PROXY_MODEL:-muse-spark}"

  export ANTHROPIC_BASE_URL="http://127.0.0.1:$_muse_port"
  export ANTHROPIC_AUTH_TOKEN="proxy"
  export ANTHROPIC_MODEL="$_muse_model"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="$_muse_model"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="$_muse_model"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$_muse_model"
  export CLAUDE_CODE_SUBAGENT_MODEL="$_muse_model"

  if [ -n "$_muse_session" ]; then
    export ANTHROPIC_CUSTOM_HEADERS="X-Muse-Session: $_muse_session"
    echo "Claude Code -> muse proxy (side chat: $_muse_session). Just run: claude"
    echo "  Reuse the same session name in a new shell to resume this chat."
  else
    unset ANTHROPIC_CUSTOM_HEADERS
    echo "Claude Code -> muse proxy (token-keyed side chat; no X-Muse-Session). Just run: claude"
  fi
  echo "  Close this shell to revert to your global Claude account."
  unset _muse_port _muse_model
fi
unset _muse_sourced _muse_session _muse_valid

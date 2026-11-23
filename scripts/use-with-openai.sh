# Point any OpenAI-compatible client (Continue.dev, Cline, OpenAI SDKs,
# custom tools) at the local muse proxy for THIS shell only.
# Close the shell to revert.
#
# Usage (must be SOURCED, not executed):
#   . ./scripts/use-with-openai.sh               # then run your client
#   . ./scripts/use-with-openai.sh my-project    # dedicated side chat on muse.ai;
#                                                # reuse the same name later to RESUME it
# Session names: letters, digits, dot, underscore, hyphen only (the name is
# embedded in a JSON header string, so anything else is rejected up front).

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
  echo "Please source this script:  . ./scripts/use-with-openai.sh [session-name]" >&2
elif [ "$_muse_valid" != "1" ]; then
  echo "Session name '$_muse_session' is not allowed - use only letters, digits, dot, underscore and hyphen." >&2
else
  _muse_port="${MUSE_PROXY_PORT:-8787}"
  _muse_model="${MUSE_PROXY_MODEL:-muse-spark}"

  export OPENAI_BASE_URL="http://127.0.0.1:$_muse_port/v1"
  export OPENAI_MODEL="$_muse_model"
  if [ -n "$_muse_session" ]; then
    # Clients that honour default headers route by the header; clients
    # that only send the key route by token derivation. Either way the
    # same client + same session name lands on the same chat every time.
    # (Note: the official OpenAI SDKs ignore OPENAI_DEFAULT_HEADERS --
    # for them the token route is the one that applies.)
    export OPENAI_API_KEY="proxy-$_muse_session"
    export OPENAI_DEFAULT_HEADERS="{\"X-Muse-Session\":\"$_muse_session\"}"
    echo "OpenAI clients -> muse proxy (side chat: $_muse_session)."
    echo "  Reuse the same session name in a new shell to resume this chat."
  else
    export OPENAI_API_KEY="proxy"
    unset OPENAI_DEFAULT_HEADERS
    echo "OpenAI clients -> muse proxy (default side chat)."
  fi
  echo "  Close this shell to revert."
  unset _muse_port _muse_model
fi
unset _muse_sourced _muse_session _muse_valid

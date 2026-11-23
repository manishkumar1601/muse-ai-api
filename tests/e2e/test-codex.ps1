# E2E: current Codex CLI against the proxy via the Responses API.
# Prereqs (see README §5a):
#   - proxy running (npm start)
#   - [model_providers.muse] with wire_api = "responses" in ~/.codex/config.toml
#   - profile file ~/.codex/muse.config.toml (model + model_provider)
# Current Codex ignores OPENAI_BASE_URL; the env key below is what the
# provider's env_key = "OPENAI_API_KEY" reads.
$env:OPENAI_API_KEY = "e2e-test"
# If codex is not installed, this script will error and that is expected
"" | codex --profile muse "reply with exactly: node-port-codex-ok"

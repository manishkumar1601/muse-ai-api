$env:OPENAI_BASE_URL = "http://127.0.0.1:8787/v1"
$env:OPENAI_API_KEY  = "e2e-test"
# Codex CLI env name varies by install; may need: $env:OPENAI_MODEL = "muse-spark"
# If codex is not installed, this script will error and that is expected
"" | codex "reply with exactly: node-port-codex-ok"

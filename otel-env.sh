# Source this in the shell where you launch `claude` to stream telemetry to the
# local Agent Activity Dashboard.  `source ./otel-env.sh`
#
# Per-stream: override team.id / department per developer or per stream.

export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
# Default targets `npm run dev:server` (port 4318). The Docker stack does not
# publish 4318 on the host, so for `docker compose up` set AAD_URL first:
#   AAD_URL=http://127.0.0.1:18418 source ./otel-env.sh
export OTEL_EXPORTER_OTLP_ENDPOINT=${AAD_URL:-http://localhost:4318}

# Real-time for the POC (default export interval is 60s / 10s).
export OTEL_LOGS_EXPORT_INTERVAL=1000
export OTEL_METRIC_EXPORT_INTERVAL=2000

# Correlation / grouping attributes shown in the dashboard.
export OTEL_RESOURCE_ATTRIBUTES="team.id=stream-mobile,department=innod"

# --- PRIVACY: never enable these. Prompt/tool content stays redacted. ---
# OTEL_LOG_USER_PROMPTS       -> MUST stay unset
# OTEL_LOG_TOOL_CONTENT       -> MUST stay unset
# OTEL_LOG_RAW_API_BODIES     -> MUST stay unset

echo "[otel-env] Claude Code telemetry -> $OTEL_EXPORTER_OTLP_ENDPOINT (team.id from OTEL_RESOURCE_ATTRIBUTES)"

#!/usr/bin/env bash
# Compatibility entry point. All new installations use the project-filtering relay.
set -euo pipefail

if [[ -z "${DASHBOARD_URL:-}" || -z "${PROJECT_PATH:-}" ]]; then
  echo "Set DASHBOARD_URL and PROJECT_PATH to the dashboard origin and one selected Git repository."
  echo "Alternatively use npm run agents:setup and npm run agents:projects."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/setup.mjs" --clients claude --url "$DASHBOARD_URL" \
  --team "${TEAM_ID:-unassigned}" --project "$PROJECT_PATH" --apply
echo "Start npm run agents:relay with AAD_TOKEN set if the dashboard requires an ingest token."
echo "Remove older direct hooks/agent.env exports, then restart Claude. See fleet/SETUP.md."

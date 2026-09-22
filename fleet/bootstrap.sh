#!/usr/bin/env bash
# Install Claude with the project-filtering relay.
set -euo pipefail

if [[ -z "${DASHBOARD_URL:-}" || -z "${PROJECT_PATH:-}" ]]; then
  echo "Set DASHBOARD_URL and PROJECT_PATH to the dashboard origin and one selected Git repository."
  echo "Alternatively use npm run agents:setup and npm run agents:projects."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/setup.mjs" --clients claude --url "$DASHBOARD_URL" \
  --team "${TEAM_ID:-unassigned}" --project "$PROJECT_PATH" --apply
echo "Provide an Accounts workstation token as HARMONIE_TOKEN, then start npm run agents:relay."
echo "Restart Claude with HARMONIE_TOKEN available in its environment. See fleet/SETUP.md."

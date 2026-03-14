#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.env"
  set +a
fi

EVENT_TYPE="${1:-stop}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-3000}"
BRIDGE_SECRET="${BRIDGE_SECRET:-}"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}/hook/claude"
INPUT="$(cat)"
SESSION_ID="${CLAUDE_SESSION_ID:-}"

if [[ -z "${BRIDGE_SECRET}" ]]; then
  echo "BRIDGE_SECRET is required." >&2
  exit 1
fi

PAYLOAD="$(
  printf '%s' "${INPUT}" | \
    HOOK_TOOL="claude" \
    HOOK_EVENT="${EVENT_TYPE}" \
    HOOK_SESSION_ID="${SESSION_ID}" \
    node --input-type=module -e '
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        const data = input.trim() ? JSON.parse(input) : {};
        process.stdout.write(
          JSON.stringify({
            tool: process.env.HOOK_TOOL,
            event: process.env.HOOK_EVENT,
            sessionId: process.env.HOOK_SESSION_ID ?? "",
            data
          })
        );
      });
    '
)"

exec curl --silent --show-error --fail \
  --request POST \
  --url "${BRIDGE_URL}" \
  --header "Content-Type: application/json" \
  --header "X-Bridge-Secret: ${BRIDGE_SECRET}" \
  --data "${PAYLOAD}"

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
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}/hook/codex"
INPUT="$(cat)"
SESSION_ID="${CODEX_SESSION_ID:-}"
NODE_BIN="${NODE_BIN:-}"

if [[ -z "${BRIDGE_SECRET}" ]]; then
  echo "BRIDGE_SECRET is required." >&2
  exit 1
fi

if [[ -z "${NODE_BIN}" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x /opt/homebrew/bin/node ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  elif [[ -x /usr/local/bin/node ]]; then
    NODE_BIN="/usr/local/bin/node"
  else
    echo "node binary not found in hook environment." >&2
    exit 127
  fi
fi

PAYLOAD="$(
  printf '%s' "${INPUT}" | \
    HOOK_TOOL="codex" \
    HOOK_EVENT="${EVENT_TYPE}" \
    HOOK_SESSION_ID="${SESSION_ID}" \
    "${NODE_BIN}" --input-type=module -e '
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
)" || {
  echo "failed to build codex hook payload." >&2
  exit 1
}

HTTP_RESPONSE="$(
  curl --silent --show-error \
    --write-out '\nHTTP_STATUS:%{http_code}' \
    --request POST \
    --url "${BRIDGE_URL}" \
    --header "Content-Type: application/json" \
    --header "X-Bridge-Secret: ${BRIDGE_SECRET}" \
    --data "${PAYLOAD}"
)" || {
  echo "failed to reach bridge endpoint ${BRIDGE_URL}." >&2
  exit 22
}

HTTP_BODY="${HTTP_RESPONSE%HTTP_STATUS:*}"
HTTP_STATUS="${HTTP_RESPONSE##*HTTP_STATUS:}"

if [[ "${HTTP_STATUS}" -lt 200 || "${HTTP_STATUS}" -ge 300 ]]; then
  echo "bridge hook request failed with status ${HTTP_STATUS}." >&2
  if [[ -n "${HTTP_BODY//[[:space:]]/}" ]]; then
    echo "${HTTP_BODY}" >&2
  fi
  exit 22
fi

if [[ -n "${HTTP_BODY//[[:space:]]/}" ]]; then
  printf '%s' "${HTTP_BODY}"
fi

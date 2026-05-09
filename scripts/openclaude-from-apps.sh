#!/usr/bin/env bash
# Launch OpenClaude from the BREEZ-APPS tree so session JSONL lands under
# ~/.openclaude/projects/<sanitized-cwd>/ or ~/.claude/projects/<sanitized-cwd>/.
# Usage: from tokenhouse-claude-breez — ./scripts/openclaude-from-apps.sh [openclaude args…]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BREEZ_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_ROOT="$(cd "$BREEZ_REPO/.." && pwd)"
TC_OPENCLAUDE="$APPS_ROOT/tokenhouse-claude/openclaude/bin/openclaude"

if [[ -x "$TC_OPENCLAUDE" ]]; then
  OPENCLAUDE_BIN="$TC_OPENCLAUDE"
elif command -v openclaude >/dev/null 2>&1; then
  OPENCLAUDE_BIN="$(command -v openclaude)"
else
  echo "openclaude not found. Install or set OPENCLAUDE_BIN. Expected: $TC_OPENCLAUDE" >&2
  exit 1
fi

# Working directory: BREEZ-APPS (parent of this repo) unless caller overrides.
WORKDIR="${OPENCLAUDE_WORKDIR:-$APPS_ROOT}"
cd "$WORKDIR"

exec "$OPENCLAUDE_BIN" "$@"

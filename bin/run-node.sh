#!/bin/sh
# Portable Node.js (>=20) launcher for Antigravity GUI Sidecars & MCP Servers on macOS/Linux.
set -e

resolve_node() {
  if [ -n "${AGY_FORK_EXPLORER_NODE:-}" ] && [ -x "$AGY_FORK_EXPLORER_NODE" ]; then
    printf '%s' "$AGY_FORK_EXPLORER_NODE"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    cand="$(command -v node)"
    ver="$("$cand" -p 'parseInt(process.versions.node,10)' 2>/dev/null || echo 0)"
    if [ "$ver" -ge 20 ]; then
      printf '%s' "$cand"
      return 0
    fi
  fi

  if [ -d "$HOME/.nvm/versions/node" ]; then
    for d in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -Vr); do
      cand="$HOME/.nvm/versions/node/$d/bin/node"
      if [ -x "$cand" ]; then
        ver="$("$cand" -p 'parseInt(process.versions.node,10)' 2>/dev/null || echo 0)"
        if [ "$ver" -ge 20 ]; then
          printf '%s' "$cand"
          return 0
        fi
      fi
    done
  fi

  for cand in \
    "$HOME/.volta/bin/node" \
    "$HOME/.fnm/current/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [ -x "$cand" ]; then
      ver="$("$cand" -p 'parseInt(process.versions.node,10)' 2>/dev/null || echo 0)"
      if [ "$ver" -ge 20 ]; then
        printf '%s' "$cand"
        return 0
      fi
    fi
  done

  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[agy-fork-explorer] Node.js >= 20 not found in PATH or standard directories." >&2
  exit 127
fi

exec "$NODE_BIN" "$@"

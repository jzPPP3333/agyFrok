#!/bin/sh
# Optional helper: launch Antigravity with local CDP debugging port enabled
# so agy-fork-explorer can attach its native Shadow DOM overlay (bubble Fork + file right-click menu).
# Usage:
#   sh launch-with-cdp.sh              # launch on port 9222 (after quitting Antigravity)
#   sh launch-with-cdp.sh --restart    # gracefully quit running Antigravity first, then relaunch with CDP
set -e

PORT="9222"
RESTART="0"
for arg in "$@"; do
  case "$arg" in
    --restart|-r) RESTART="1" ;;
    [0-9]*) PORT="$arg" ;;
  esac
done

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  APP_PATH="/Applications/Antigravity.app"
  if [ ! -d "$APP_PATH" ]; then
    APP_PATH="$HOME/Applications/Antigravity.app"
  fi
  if [ ! -d "$APP_PATH" ]; then
    echo "[agy-fork-explorer] 未在 /Applications 或 ~/Applications 找到 Antigravity.app" >&2
    exit 1
  fi

  if pgrep -x "Antigravity" >/dev/null 2>&1; then
    if [ "$RESTART" = "1" ]; then
      echo "[agy-fork-explorer] 正在优雅退出当前 Antigravity..."
      osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
      i=0
      while pgrep -x "Antigravity" >/dev/null 2>&1 && [ "$i" -lt 25 ]; do
        sleep 0.3
        i=$((i + 1))
      done
    else
      echo "[agy-fork-explorer] 检测到 Antigravity 已在运行！"
      echo "macOS 下已运行的 App 会忽略 --args 参数。请先按 ⌘+Q 完全退出 Antigravity，或直接执行："
      echo "  sh \"$0\" --restart"
      exit 0
    fi
  fi

  echo "[agy-fork-explorer] 正在以 --remote-debugging-port=$PORT 启动 $APP_PATH ..."
  open -a "$APP_PATH" --args "--remote-debugging-port=$PORT"
else
  BIN="$(command -v antigravity || command -v Antigravity || true)"
  if [ -z "$BIN" ]; then
    echo "[agy-fork-explorer] PATH 中未找到 antigravity 可执行文件" >&2
    exit 1
  fi
  echo "[agy-fork-explorer] 正在以 --remote-debugging-port=$PORT 启动 $BIN ..."
  nohup "$BIN" "--remote-debugging-port=$PORT" >/dev/null 2>&1 &
fi

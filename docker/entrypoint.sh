#!/usr/bin/env bash
# 容器入口:
#   root 阶段: 修正数据卷属主 -> 降权为 snowluma 重新执行本脚本
#   snowluma 阶段: Xvfb + QQ(--no-sandbox) 后台运行, SnowLuma 前台托管;
#                  QQ 崩溃自动重启, SnowLuma/Xvfb 退出则容器退出交给 restart 策略
set -euo pipefail

APP_USER="${APP_USER:-node}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data "$HOME/.config/QQ" /tmp/runtime-snowluma
  chown -R "$APP_USER":"$APP_USER" /app/data "$HOME/.config" /tmp/runtime-snowluma
  # 降权为业务用户但保留 CAP_SYS_PTRACE（ambient caps）:
  # SnowLuma 与 QQ 是兄弟进程，宿主 Yama ptrace_scope=1 下兄弟注入必须有该能力
  exec setpriv --reuid "$APP_USER" --regid "$APP_USER" --clear-groups \
    --inh-caps=+sys_ptrace --ambient-caps=+sys_ptrace \
    /bin/bash /app/entrypoint.sh
fi

export DISPLAY="${DISPLAY:-:99}"
export SNOWLUMA_WEBUI_HOST="${SNOWLUMA_WEBUI_HOST:-0.0.0.0}"
export SNOWLUMA_HOOK_AUTOLOAD="${SNOWLUMA_HOOK_AUTOLOAD:-1}"
export XDG_RUNTIME_DIR=/tmp/runtime-snowluma
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
# QQ 会预留超大虚拟地址空间，崩溃时可能写出巨型 core，直接关闭
ulimit -c 0

start_qq() {
  /opt/QQ/qq --no-sandbox ${QQ_ARGS:-} &
  QQ_PID=$!
  echo "[entrypoint] QQ started (pid $QQ_PID)"
}

shutdown() {
  echo "[entrypoint] shutting down"
  kill -TERM "${SNOW_PID:-}" "${QQ_PID:-}" "${XVFB_PID:-}" "${X11VNC_PID:-}" "${NOVNC_PID:-}" 2>/dev/null || true
  wait "${SNOW_PID:-}" 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 "${XVFB_SCREEN:-1280x720x24}" -nolisten tcp &
XVFB_PID=$!
echo "[entrypoint] Xvfb started (pid $XVFB_PID)"

# noVNC: 把虚拟屏幕暴露为网页端，浏览器打开 :5901 即可看到 QQ 登录窗口扫码。
# 仅容器内监听，是否对外暴露由 compose 的端口映射决定。
if command -v x11vnc >/dev/null 2>&1; then
  x11vnc -display :99 -rfbport 5900 -listen localhost -forever -shared -nopw -quiet &
  X11VNC_PID=$!
  echo "[entrypoint] x11vnc started (pid $X11VNC_PID) on :5900"
  if command -v websockify >/dev/null 2>&1 && [ -d /usr/share/novnc ]; then
    websockify --web /usr/share/novnc "${NOVNC_PORT:-5901}" localhost:5900 &
    NOVNC_PID=$!
    echo "[entrypoint] noVNC started (pid $NOVNC_PID), open http://0.0.0.0:${NOVNC_PORT:-5901}/vnc.html"
  fi
fi

start_qq

# cwd 保持 /app/data（数据卷），config/ logs/ 及账号数据全部落盘持久化；
# 产物路径用绝对地址，native 注入件由 bundle 自身路径（/app/dist/native）解析
cd /app/data
node /app/dist/index.mjs &
SNOW_PID=$!
echo "[entrypoint] SnowLuma started (pid $SNOW_PID), WebUI: http://0.0.0.0:${SNOWLUMA_WEBUI_PORT:-5099}"

# 监督循环: sleep 放入 wait 使信号可即时打断
while true; do
  if ! kill -0 "$SNOW_PID" 2>/dev/null; then
    wait "$SNOW_PID" || true
    echo "[entrypoint] SnowLuma exited, container stops (restart policy takes over)" >&2
    exit 1
  fi
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[entrypoint] Xvfb exited, container stops (restart policy takes over)" >&2
    exit 1
  fi
  if ! kill -0 "$QQ_PID" 2>/dev/null; then
    wait "$QQ_PID" 2>/dev/null || true
    echo "[entrypoint] QQ exited, restarting in 3s" >&2
    sleep 3
    start_qq
  fi
  sleep 5 &
  wait $! || true
done

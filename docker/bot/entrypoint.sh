#!/bin/bash
# agenta-bot entrypoint (PID 1 is tini). Starts the virtual desktop, then runs CMD (default: sleep infinity).
# Desktop: Xvfb :99 -> fluxbox -> x11vnc (container-local :5900) -> websockify + noVNC on :6080.
# Each daemon is kept alive by a small restart loop; logs go to /tmp/agenta/*.log.
set -u

LOG_DIR=/tmp/agenta
mkdir -p "$LOG_DIR"
export DISPLAY="${DISPLAY:-:99}"
SCREEN="${AGENTA_SCREEN:-1440x900x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
DISPLAY_NUM="${DISPLAY#:}"

log() { echo "[agenta-entrypoint] $*"; }

# The home is bind-mounted per bot (F05); make sure the expected layout exists.
for d in "$HOME/work" "$HOME/.claude" "$HOME/.codex"; do
  mkdir -p "$d" 2>/dev/null || log "warning: cannot create $d (is the home mount writable by uid $(id -u)?)"
done

# keep NAME CMD...: run CMD forever, restarting it after a short pause if it exits.
keep() {
  local name="$1"; shift
  (
    while true; do
      "$@" >>"$LOG_DIR/$name.log" 2>&1
      echo "[$(date -u +%FT%TZ)] $name exited with $?; restarting in 1s" >>"$LOG_DIR/$name.log"
      sleep 1
    done
  ) &
}

# A stale lock from a previous start (container restart) would stop Xvfb from binding the display.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null

keep xvfb Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
  sleep 0.1
done
[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] || log "warning: Xvfb socket did not appear; see $LOG_DIR/xvfb.log"

keep fluxbox fluxbox
# No VNC password: x11vnc only listens inside the container, and the noVNC port is published to 127.0.0.1 only.
keep x11vnc x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -nopw -forever -shared -quiet
keep websockify websockify --web /usr/share/novnc "$NOVNC_PORT" 127.0.0.1:5900

log "desktop starting on $DISPLAY ($SCREEN), noVNC on :$NOVNC_PORT"
exec "$@"

#!/usr/bin/env bash
# The `yakkbot` command: run and look after a YakkBot install. Installed by install.sh.
set -euo pipefail

YAKK_DIR="${YAKK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
YAKK_HOME="${YAKK_HOME:-$HOME/.yakkbot}"
export YAKK_HOME
ENV_FILE="$YAKK_HOME/.env"
PID_FILE="$YAKK_HOME/yakkbot.pid"
LOG_FILE="$YAKK_HOME/yakkbot.log"
IS_TERMUX=0; { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; } && IS_TERMUX=1

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
val() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'; }
port() { local p; p="$(val PORT)"; echo "${p:-8787}"; }

# Set KEY=value in the settings file, replacing a line (commented or not) if there is one.
setenv() {
  local key="$1" value="$2" tmp
  umask 077; mkdir -p "$YAKK_HOME"; touch "$ENV_FILE"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} { if (!done && $0 ~ "^#?[[:space:]]*" k "=") { print k "=" v; done=1 } else print } END{ if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"; chmod 600 "$ENV_FILE"
}

pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true; }
running() { local p; p="$(pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

start() {
  if running; then say "YakkBot is already running (pid $(pid)) on http://localhost:$(port)"; return; fi
  [ -f "$YAKK_DIR/server/dist/index.js" ] || die "Not built yet. Run: yakkbot update"
  (umask 077; mkdir -p "$YAKK_HOME")
  # Keep the phone from putting Termux to sleep while the bots work.
  [ "$IS_TERMUX" = 1 ] && have termux-wake-lock && termux-wake-lock || true
  # Keep the last run's log, start a fresh one.
  [ -f "$LOG_FILE" ] && mv -f "$LOG_FILE" "$LOG_FILE.1" || true
  # Fully detached: no terminal, no inherited pipes, its own session where setsid exists.
  local launch=(nohup); have setsid && launch=(setsid nohup)
  cd "$YAKK_DIR" || die "No such folder: $YAKK_DIR"
  "${launch[@]}" node --disable-warning=ExperimentalWarning server/dist/index.js < /dev/null >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$(port)/api/health" >/dev/null 2>&1; then say "YakkBot is up: http://localhost:$(port)"; return; fi
    running || { tail -15 "$LOG_FILE" >&2; die "YakkBot stopped while starting. Full log: $LOG_FILE"; }
    sleep 0.5
  done
  say "Started (pid $(pid)), still warming up. Check: yakkbot status"
}

stop() {
  if running; then
    kill "$(pid)" 2>/dev/null || true
    for _ in $(seq 1 20); do running || break; sleep 0.25; done
    running && kill -9 "$(pid)" 2>/dev/null || true
    say "Stopped."
  else say "YakkBot is not running."; fi
  rm -f "$PID_FILE"
  [ "$IS_TERMUX" = 1 ] && have termux-wake-unlock && termux-wake-unlock || true
}

status() {
  if running; then
    say "running (pid $(pid))  http://localhost:$(port)"
    curl -fsS "http://127.0.0.1:$(port)/api/health" 2>/dev/null && echo || say "…but not answering yet"
  else say "stopped"; fi
}

update() {
  cd "$YAKK_DIR"
  if [ -d .git ]; then say "Fetching the latest code"; git pull --ff-only || die "Could not update (local changes?). Fix that, then run again."; fi
  say "Installing dependencies"; npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
  say "Building"; npm run build --silent
  if running; then stop; start; fi
}

boot() {
  if [ "$IS_TERMUX" = 1 ]; then
    mkdir -p "$HOME/.termux/boot"
    printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\n%s start\n' "$(command -v yakkbot || echo "bash $YAKK_DIR/scripts/yakkbot.sh")" > "$HOME/.termux/boot/yakkbot"
    chmod +x "$HOME/.termux/boot/yakkbot"
    say "YakkBot will start when the phone boots. This needs the Termux:Boot app (F-Droid), opened once."
  elif have systemctl && [ "$(uname -s)" = Linux ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/yakkbot.service" <<UNIT
[Unit]
Description=YakkBot
After=network-online.target

[Service]
Environment=YAKK_HOME=$YAKK_HOME
WorkingDirectory=$YAKK_DIR
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $YAKK_DIR/server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    stop >/dev/null 2>&1 || true
    systemctl --user daemon-reload && systemctl --user enable --now yakkbot.service
    say "YakkBot now runs as a user service (systemctl --user status yakkbot). To keep it up while logged out: loginctl enable-linger $USER"
  else
    say "Add this to your login items or crontab:  @reboot $(command -v yakkbot || echo "bash $YAKK_DIR/scripts/yakkbot.sh") start"
  fi
}

desktop() {
  case "${1:-}" in
    setup)
      local pw; pw="$(openssl rand -base64 9 | tr -d '/+=' | cut -c1-8)"
      if [ "$IS_TERMUX" = 1 ]; then
        say "Installing a desktop for the bots (XFCE + VNC). This is a large download."
        pkg install -y x11-repo && pkg install -y tigervnc xfce4 xdotool scrot
      elif have apt-get; then
        sudo apt-get update -qq && sudo apt-get install -y tigervnc-standalone-server xfce4 xdotool scrot dbus-x11
      else die "Install a VNC server, a desktop, xdotool and scrot with your package manager, then set VNC_PORT and VNC_PASSWORD in $ENV_FILE."; fi
      mkdir -p "$HOME/.vnc"
      printf '%s\n' "$pw" | vncpasswd -f > "$HOME/.vnc/passwd"; chmod 600 "$HOME/.vnc/passwd"
      printf '#!/bin/sh\nexec startxfce4\n' > "$HOME/.vnc/xstartup"; chmod +x "$HOME/.vnc/xstartup"
      setenv VNC_PORT 5901; setenv VNC_PASSWORD "$pw"; setenv YAKK_COMPUTER local
      say "Desktop set up. Start it with: yakkbot desktop start   (then: yakkbot restart)"
      ;;
    start) vncserver -localhost -geometry "${2:-1280x800}" :1 && say "Desktop running on display :1" ;;
    stop) vncserver -kill :1 || true ;;
    *) say "usage: yakkbot desktop setup | start [WIDTHxHEIGHT] | stop" ;;
  esac
}

doctor() {
  local ok=1
  check() { if eval "$2" >/dev/null 2>&1; then say "ok    $1"; else say "MISSING  $1  ${3:-}"; ok=0; fi; }
  check "node >= 22.13 ($(node -v 2>/dev/null || echo none))" "node -e \"const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)\"" "(install Node 22 or newer)"
  check "built app" "[ -f '$YAKK_DIR/server/dist/index.js' ] && [ -f '$YAKK_DIR/web/dist/index.html' ]" "(yakkbot update)"
  check "settings file $ENV_FILE" "[ -f '$ENV_FILE' ]"
  check "passphrase set" "[ -n \"\$(val YAKK_PASSWORD)\" ]" "(yakkbot password)"
  check "settings file is private" "[ \"\$(stat -c %a '$ENV_FILE' 2>/dev/null || stat -f %Lp '$ENV_FILE')\" = 600 ]" "(chmod 600 $ENV_FILE)"
  if [ "$IS_TERMUX" = 1 ]; then
    check "termux-api package" "have termux-battery-status" "(pkg install termux-api)"
    check "Termux:API app answers" "timeout 8 termux-battery-status" "(install the Termux:API app from F-Droid)"
  fi
  [ "$(val HOST)" = "0.0.0.0" ] && say "note  the app is open to your network (HOST=0.0.0.0). Anyone on it who has the passphrase can use your bots."
  running && say "ok    running (pid $(pid))" || say "note  not running (yakkbot start)"
  [ "$ok" = 1 ]
}

case "${1:-help}" in
  start) start ;;
  stop) stop ;;
  restart) stop >/dev/null 2>&1 || true; start ;;
  status) status ;;
  logs) tail -n "${2:-80}" -f "$LOG_FILE" ;;
  open)
    url="http://localhost:$(port)"
    if have termux-open-url; then termux-open-url "$url"; elif have xdg-open; then xdg-open "$url"; elif have open; then open "$url"; else say "$url"; fi ;;
  password)
    new="${2:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)}"
    setenv YAKK_PASSWORD "$new"; say "New passphrase: $new"; running && { stop >/dev/null; start; } ;;
  key)
    [ $# -ge 3 ] || die "usage: yakkbot key <anthropic|openai|openrouter|gemini|groq|xai|composio|tavily> <key>"
    name="$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')_API_KEY"
    setenv "$name" "$3"; say "Saved $name."; running && { stop >/dev/null; start; } ;;
  set) [ $# -ge 3 ] || die "usage: yakkbot set NAME value"; setenv "$2" "$3"; say "Saved $2. Restart to apply: yakkbot restart" ;;
  lan)
    case "${2:-}" in
      on) setenv HOST 0.0.0.0; say "Open to your network after a restart. Use the passphrase; do not do this on public Wi-Fi." ;;
      off) setenv HOST 127.0.0.1; say "This device only, after a restart." ;;
      *) say "usage: yakkbot lan on|off" ;;
    esac ;;
  update) update ;;
  boot) boot ;;
  desktop) shift; desktop "$@" ;;
  doctor) doctor ;;
  backup)
    out="${2:-$HOME/yakkbot-backup-$(date +%Y%m%d-%H%M%S).tgz}"
    tar -czf "$out" -C "$(dirname "$YAKK_HOME")" --exclude='node' --exclude='*.log*' "$(basename "$YAKK_HOME")"; chmod 600 "$out"
    say "Backed up settings, bots, memories and files to $out (it contains your keys: keep it private)." ;;
  uninstall)
    stop >/dev/null 2>&1 || true
    rm -f "$HOME/.termux/boot/yakkbot" "$HOME/.config/systemd/user/yakkbot.service"
    say "Stopped and removed from startup. Your data is still in $YAKK_HOME and the code in $YAKK_DIR; delete those folders to remove everything." ;;
  *)
    cat <<HELP
yakkbot: your own team of AI agents

  yakkbot start | stop | restart | status
  yakkbot open                 open the app in your browser
  yakkbot logs [lines]         follow the log
  yakkbot key <provider> <key> save a model key (anthropic, openai, openrouter, gemini, groq, xai...)
  yakkbot set NAME value       change any setting in $ENV_FILE
  yakkbot password [new]       set a new sign-in passphrase
  yakkbot lan on|off           open the app to your Wi-Fi, or keep it on this device
  yakkbot boot                 start YakkBot when the device boots
  yakkbot desktop setup|start|stop   a desktop the bots can use and you can watch
  yakkbot update               fetch the latest version and rebuild
  yakkbot backup [file]        save settings, bots, memories and files
  yakkbot doctor               check the install
  yakkbot uninstall
HELP
    ;;
esac

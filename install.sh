#!/usr/bin/env bash
# YakkBot installer for Android (Termux), Linux, Chromebook (Crostini) and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/deezi74/YakkBot/main/install.sh | bash
#   # or, inside a clone:   bash install.sh
#
# It checks what is missing, installs it, builds the app, writes ~/.yakkbot/.env with a fresh
# passphrase, and puts a `yakkbot` command on your PATH. Running it again upgrades in place and
# keeps your settings and data.
#
# Options (environment): YAKK_DIR (where the code goes, default ~/yakkbot), YAKK_HOME (settings and
# data, default ~/.yakkbot), YAKK_REPO, YAKK_BRANCH, PORT.
set -euo pipefail

REPO="${YAKK_REPO:-https://github.com/deezi74/YakkBot.git}"
BRANCH="${YAKK_BRANCH:-main}"
YAKK_HOME="${YAKK_HOME:-$HOME/.yakkbot}"
PORT="${PORT:-8787}"
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=13

say()  { printf '\033[1;38;5;208m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- where are we -------------------------------------------------------------------------------
PLATFORM=linux
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then PLATFORM=termux
elif [ "$(uname -s)" = Darwin ]; then PLATFORM=macos
elif [ -f /etc/apt/sources.list.d/cros.list ] || [ -d /opt/google/cros-containers ]; then PLATFORM=crostini
fi
ARCH="$(uname -m)"
say "Platform: $PLATFORM ($ARCH)"

SUDO=""
if [ "$PLATFORM" != termux ] && [ "$(id -u)" != 0 ] && have sudo; then SUDO=sudo; fi

node_ok() {
  have node || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NODE_MIN_MAJOR||(a===$NODE_MIN_MAJOR&&b>=$NODE_MIN_MINOR)?0:1)"
}

# ---- dependencies -------------------------------------------------------------------------------
install_deps() {
  case "$PLATFORM" in
    termux)
      # Termux does not support partial upgrades: a Node.js built for newer libraries than the ones
      # installed fails with "CANNOT LINK EXECUTABLE ... libicu...so not found". Bring everything current first.
      say "Updating Termux packages (a few minutes the first time)"
      yes | pkg update >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        || warn "Some packages did not update; continuing."
      say "Installing Node.js, git and Termux:API tools"
      if pkg list-installed 2>/dev/null | grep -q '^nodejs/'; then
        pkg install -y nodejs git openssl-tool termux-api
      else
        pkg install -y nodejs-lts git openssl-tool termux-api || pkg install -y nodejs git openssl-tool termux-api
      fi
      # llama.cpp runs GGUF models on the phone (Settings > On-device models). Optional.
      pkg install -y llama-cpp >/dev/null 2>&1 || warn "Could not install llama-cpp; on-device models need it (pkg install llama-cpp)."
      # Still broken after the upgrade: reinstall Node and the library it links against.
      if have node && ! node -v >/dev/null 2>&1; then
        say "Repairing Node.js"
        local pkgname=nodejs-lts; pkg list-installed 2>/dev/null | grep -q '^nodejs/' && pkgname=nodejs
        pkg reinstall -y libicu "$pkgname" || true
      fi
      ;;
    linux|crostini)
      local missing=()
      have git || missing+=(git); have curl || missing+=(curl); have openssl || missing+=(openssl)
      if [ ${#missing[@]} -gt 0 ]; then
        say "Installing ${missing[*]}"
        if have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${missing[@]}" ca-certificates
        elif have dnf; then $SUDO dnf install -y "${missing[@]}"
        elif have pacman; then $SUDO pacman -Sy --noconfirm "${missing[@]}"
        else die "Install ${missing[*]} with your package manager, then run this again."; fi
      fi
      if ! node_ok; then
        say "Installing Node.js $NODE_MIN_MAJOR (your system has none, or an older one)"
        local narch; case "$ARCH" in x86_64|amd64) narch=x64;; aarch64|arm64) narch=arm64;; *) die "No Node.js build for $ARCH; install Node >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR yourself.";; esac
        local ver; ver="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$narch.tar.gz" | head -1)"
        [ -n "$ver" ] || die "Could not find a Node.js download."
        mkdir -p "$YAKK_HOME/node"
        curl -fsSL "https://nodejs.org/dist/latest-v22.x/$ver" | tar -xz -C "$YAKK_HOME/node" --strip-components=1
        export PATH="$YAKK_HOME/node/bin:$PATH"
      fi
      ;;
    macos)
      if ! node_ok; then
        have brew || die "Install Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR (https://nodejs.org) or Homebrew, then run this again."
        say "Installing Node.js with Homebrew"; brew install node
      fi
      have git || die "Install git (xcode-select --install), then run this again."
      ;;
  esac
  if ! node_ok; then
    if have node && ! node -v >/dev/null 2>&1; then
      node -v 2>&1 | head -2 >&2
      [ "$PLATFORM" = termux ] && die "Node.js is installed but will not start (above). Run: pkg upgrade -y && pkg reinstall -y libicu nodejs-lts   then run this installer again."
      die "Node.js is installed but will not start (above). Reinstall Node.js, then run this installer again."
    fi
    die "Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR is needed (found: $(node -v 2>/dev/null || echo none))."
  fi
  say "Node $(node -v), npm $(npm -v)"
}

# ---- the code -----------------------------------------------------------------------------------
fetch_code() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/package.json" ] && grep -q '"name": "yakkbot"' "$here/package.json" 2>/dev/null; then
    YAKK_DIR="$here"; say "Using the checkout at $YAKK_DIR"
  else
    YAKK_DIR="${YAKK_DIR:-$HOME/yakkbot}"
    if [ -d "$YAKK_DIR/.git" ]; then
      say "Updating $YAKK_DIR"; git -C "$YAKK_DIR" fetch --depth 1 origin "$BRANCH" && git -C "$YAKK_DIR" reset --hard FETCH_HEAD
    else
      say "Downloading YakkBot to $YAKK_DIR"; git clone --depth 1 --branch "$BRANCH" "$REPO" "$YAKK_DIR"
    fi
  fi
}

build() {
  cd "$YAKK_DIR"
  say "Installing dependencies (a few minutes on a phone)"
  npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
  say "Building"
  npm run build --silent
  [ -f server/dist/index.js ] && [ -f web/dist/index.html ] || die "The build did not produce the app."
}

# ---- settings -----------------------------------------------------------------------------------
write_env() {
  umask 077; mkdir -p "$YAKK_HOME"
  if [ -f "$YAKK_HOME/.env" ]; then say "Keeping your settings in $YAKK_HOME/.env"; return; fi
  local pass; pass="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  cat > "$YAKK_HOME/.env" <<ENV
# YakkBot settings. Edit, then: yakkbot restart
PORT=$PORT
# 127.0.0.1 keeps the app on this device. 0.0.0.0 opens it to your Wi-Fi (use the passphrase!).
HOST=127.0.0.1
YAKK_OWNER=${USER:-Owner}
YAKK_PASSWORD=$pass

# ---- a model: one key is enough (or add it in the app: bot > details > Engine) ----
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# GEMINI_API_KEY=
# GROQ_API_KEY=
# OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
# CUSTOM_BASE_URL=            # any OpenAI-compatible server
# CUSTOM_API_KEY=

# ---- safety ----
# risky = ask before destructive or outward-facing shell commands; always = ask before every one; off
YAKK_SHELL_APPROVAL=risky

# ---- add-ons (all optional) ----
# XAI_API_KEY=                # voice calls and research on X
# COMPOSIO_API_KEY=           # connected apps (Gmail, Slack, GitHub...) with approvals
# TELEGRAM_BOT_TOKEN=         # text your bots from Telegram
# TELEGRAM_ALLOWED_CHATS=     # your chat id; message the bot once and it tells you
# TAVILY_API_KEY=             # better web search (falls back to DuckDuckGo)
# VNC_PORT=5901               # a desktop the bots can use and you can watch (yakkbot desktop setup)
# VNC_PASSWORD=
ENV
  NEW_PASS="$pass"
}

install_cli() {
  local bin
  if [ "$PLATFORM" = termux ]; then bin="$PREFIX/bin"; else bin="$HOME/.local/bin"; mkdir -p "$bin"; fi
  cat > "$bin/yakkbot" <<CLI
#!/usr/bin/env bash
export YAKK_DIR="$YAKK_DIR" YAKK_HOME="$YAKK_HOME"
[ -d "$YAKK_HOME/node/bin" ] && export PATH="$YAKK_HOME/node/bin:\$PATH"
exec bash "$YAKK_DIR/scripts/yakkbot.sh" "\$@"
CLI
  chmod +x "$bin/yakkbot" "$YAKK_DIR/scripts/yakkbot.sh"
  case ":$PATH:" in *":$bin:"*) ;; *) warn "$bin is not on your PATH. Add it:  echo 'export PATH=\"$bin:\$PATH\"' >> ~/.bashrc" ;; esac
  YAKK_BIN="$bin/yakkbot"
}

# Let the YakkBot Android app start the server through Termux (its RUN_COMMAND intent is off by default).
allow_app_control() {
  [ "$PLATFORM" = termux ] || return 0
  mkdir -p "$HOME/.termux"
  local f="$HOME/.termux/termux.properties"
  touch "$f"
  if grep -Eq '^[[:space:]]*allow-external-apps[[:space:]]*=' "$f"; then
    sed -i -E 's/^[[:space:]]*allow-external-apps[[:space:]]*=.*/allow-external-apps = true/' "$f"
  else
    printf '\n# Lets the YakkBot app start and stop the server.\nallow-external-apps = true\n' >> "$f"
  fi
  have termux-reload-settings && termux-reload-settings || true
}

install_deps
fetch_code
build
allow_app_control
NEW_PASS=""
write_env
install_cli

say "Starting YakkBot"
"$YAKK_BIN" restart || true

echo
say "YakkBot is installed."
echo "   Open:        http://localhost:$PORT"
[ -n "$NEW_PASS" ] && echo "   Passphrase:  $NEW_PASS      (saved in $YAKK_HOME/.env; change with: yakkbot password)"
echo "   Add a model: open your bot > details > Engine, pick a provider, paste a key"
echo "                or: yakkbot key anthropic sk-ant-..."
echo "   Commands:    yakkbot status | logs | stop | restart | update | boot | doctor"
[ "$PLATFORM" = termux ] && echo "   Phone tools: install the Termux:API app (F-Droid) so bots can notify you, read the clipboard, text, etc."
[ "$PLATFORM" = termux ] && echo "   The app:     install the YakkBot app for a home-screen icon and phone control:"
[ "$PLATFORM" = termux ] && echo "                https://github.com/deezi74/YakkBot/releases/latest/download/yakkbot.apk"
exit 0

#!/bin/sh
# 用户级一键安装：只创建新实例，不覆盖系统 Node/npm 或已有 Agent。
set -eu
umask 077

NODE_CHANNEL=24
REGISTRY=https://pkg.yeaft.com/
PACKAGE=@yeaft/webchat-agent@latest
SERVER=
SECRET=
PREFIX=
SERVICE_ATTEMPTED=false

usage() {
  cat <<'EOF'
Usage: install.sh --server <ws:// or wss:// URL> --secret <agent secret>

Installs a new Yeaft Agent in ~/.yeaft/installations/<hostname>-NNNN.
Requires a Linux systemd user session or macOS launchd login session.
Reuses Node >=22.5.0 with npm, or downloads a private Node 24 runtime.
No sudo, system PATH changes, or upgrades/restarts of existing Agents.
EOF
}
fail() { printf '%s\n' "Yeaft Agent installation failed: $1" >&2; exit 1; }
cleanup() {
  # PREFIX is assigned only AFTER successful exclusive creation. Once service
  # installation starts, retain its runtime/config/logs for recovery.
  if [ -n "$PREFIX" ] && [ "$SERVICE_ATTEMPTED" = false ]; then rm -rf "$PREFIX"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) [ "$#" -ge 2 ] || fail '--server requires a value'; SERVER=$2; shift 2 ;;
    --secret) [ "$#" -ge 2 ] || fail '--secret requires a value'; SECRET=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail 'unknown argument (use --help)' ;;
  esac
done
case "$SERVER" in ws://?*|wss://?*) ;; *) fail '--server must be a ws:// or wss:// URL' ;; esac
[ -n "$SECRET" ] || fail '--secret must not be empty'
CR=$(printf '\r')
case "$SERVER$SECRET$HOME" in *"
"*|*"$CR"*) fail 'arguments and home directory must not contain line breaks' ;; esac

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || fail 'Linux requires systemctl and a systemd user session'
    systemctl --user show-environment >/dev/null 2>&1 || fail 'Linux requires an available systemd user manager; log in with a systemd user session and retry'
    PLATFORM=linux ;;
  Darwin)
    command -v launchctl >/dev/null 2>&1 || fail 'macOS requires launchd'
    launchctl print "gui/$(id -u)" >/dev/null 2>&1 || fail 'macOS requires a graphical login session for launchd'
    PLATFORM=darwin ;;
  *) fail 'unsupported operating system (use PowerShell on Windows)' ;;
esac
case "$ARCH" in x86_64|amd64) NODE_ARCH=x64 ;; arm64|aarch64) NODE_ARCH=arm64 ;; *) fail 'supported CPU architectures are x64 and arm64' ;; esac
version_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<5))process.exit(1);require("node:sqlite")' >/dev/null 2>&1
}
NODE=
NPM=
if command -v node >/dev/null 2>&1; then
  CANDIDATE_NODE=$(command -v node)
  # Resolve relative PATH entries, but retain the bin directory that owns npm.
  CANDIDATE_NODE=$(cd "$(dirname "$CANDIDATE_NODE")" && pwd)/node
  CANDIDATE_NPM=$(dirname "$CANDIDATE_NODE")/npm
  if [ -x "$CANDIDATE_NPM" ] && version_ok "$CANDIDATE_NODE" && PATH="$(dirname "$CANDIDATE_NODE"):$PATH" "$CANDIDATE_NPM" --version >/dev/null 2>&1; then
    NODE=$CANDIDATE_NODE
    NPM=$CANDIDATE_NPM
  fi
fi

ROOT=$HOME/.yeaft/installations
HOST=$(hostname 2>/dev/null || printf agent)
HOST=$(printf '%s' "$HOST" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//' | cut -c1-40)
[ -n "$HOST" ] || HOST=agent
mkdir -p "$ROOT"
tries=0
while [ "$tries" -lt 100 ]; do
  tries=$((tries + 1))
  DIGITS=$(od -An -N4 -tu4 /dev/urandom | awk '{printf "%04d", $1 % 10000}')
  case "$DIGITS" in [0-9][0-9][0-9][0-9]) ;; *) fail 'could not generate an instance name' ;; esac
  NAME=$HOST-$DIGITS
  if [ -e "$HOME/.config/yeaft-agent/instances/$NAME" ] || [ -L "$HOME/.config/yeaft-agent/instances/$NAME" ] ||
     [ -e "$HOME/.yeaft/instances/$NAME" ] || [ -L "$HOME/.yeaft/instances/$NAME" ] ||
     [ -e "$HOME/.config/systemd/user/yeaft-agent@$NAME.service" ] || [ -L "$HOME/.config/systemd/user/yeaft-agent@$NAME.service" ] ||
     [ -e "$HOME/Library/LaunchAgents/com.yeaft.agent.$NAME.plist" ] || [ -L "$HOME/Library/LaunchAgents/com.yeaft.agent.$NAME.plist" ]; then continue; fi
  if mkdir "$ROOT/$NAME" 2>/dev/null; then PREFIX=$ROOT/$NAME; break; fi
done
[ -n "$PREFIX" ] || fail 'could not allocate a unique Agent name'

if [ -z "$NODE" ]; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required to download Node.js'
  command -v tar >/dev/null 2>&1 || fail 'tar is required to unpack Node.js'
  printf 'Downloading a private Node.js 24 runtime...\n'
  STAGING=$PREFIX/.download
  mkdir "$STAGING"
  SUMS=$STAGING/SHASUMS256.txt
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$SUMS" "https://nodejs.org/dist/latest-v$NODE_CHANNEL.x/SHASUMS256.txt" || fail 'could not download Node.js checksums'
  FILE=$(awk -v suffix="-$PLATFORM-$NODE_ARCH.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$SUMS")
  [ -n "$FILE" ] || fail 'no supported Node.js archive was listed by nodejs.org'
  VERSION=${FILE#node-}; VERSION=${VERSION%%-*}
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$STAGING/$FILE" "https://nodejs.org/dist/$VERSION/$FILE" || fail 'could not download Node.js'
  EXPECTED=$(awk -v f="$FILE" '$2==f {print $1; exit}' "$SUMS")
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$STAGING/$FILE" | awk '{print $1}');
  elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$STAGING/$FILE" | awk '{print $1}');
  else fail 'sha256sum or shasum is required to verify Node.js'; fi
  [ "${#EXPECTED}" -eq 64 ] && [ "$ACTUAL" = "$EXPECTED" ] || fail 'Node.js checksum verification failed'
  mkdir "$PREFIX/runtime"
  tar -xzf "$STAGING/$FILE" -C "$PREFIX/runtime" --strip-components=1 || fail 'could not unpack Node.js'
  NODE=$PREFIX/runtime/bin/node
  NPM=$PREFIX/runtime/bin/npm
  version_ok "$NODE" || fail 'downloaded Node.js cannot run on this OS or does not meet the minimum version'
  PATH="$(dirname "$NODE"):$PATH" "$NPM" --version >/dev/null 2>&1 || fail 'downloaded Node.js did not provide a working npm'
  rm -rf "$STAGING"
fi

YEAFT_INSTALL_SERVER="$SERVER" "$NODE" -e 'try {const u=new URL(process.env.YEAFT_INSTALL_SERVER);if(!["ws:","wss:"].includes(u.protocol)||!u.hostname||u.username||u.password)process.exit(1)}catch{process.exit(1)}' >/dev/null 2>&1 || fail 'invalid server URL'
NODE_DIR=$(dirname "$NODE")
printf 'Installing the Yeaft Agent in %s...\n' "$PREFIX"
PATH="$NODE_DIR:$PREFIX/bin:$PATH" "$NPM" --prefix "$PREFIX" --global install "$PACKAGE" \
  --registry="$REGISTRY" --no-audit --no-fund --loglevel=error || fail 'npm could not install the Yeaft Agent'
CLI_JS=$PREFIX/lib/node_modules/@yeaft/webchat-agent/cli.js
[ -f "$CLI_JS" ] || fail 'the installed package did not provide yeaft-agent'

WRAPPER=$PREFIX/yeaft-agent
{
  printf '#!/bin/sh\nPATH=%s:"$PATH"; export PATH\n' "$(quote "$NODE_DIR:$PREFIX/bin")"
  printf '%s\n' 'for arg in "$@"; do if [ "$arg" = upgrade ]; then echo "Use this Agent instance in the Web UI to upgrade safely; standalone CLI upgrade targets a global npm installation." >&2; exit 1; fi; done'
  printf 'exec %s %s "$@" --name %s --yeaft-dir %s\n' "$(quote "$NODE")" "$(quote "$CLI_JS")" "$(quote "$NAME")" "$(quote "$PREFIX/data")"
} > "$WRAPPER"
chmod 700 "$WRAPPER"
printf '%s\n' "$WRAPPER" > "$PREFIX/management-command"
# Use explicit roots rather than inheriting another Agent's WORK_DIR/YEAFT_DIR.
# Secret is a script argument, but is not passed through a shell to the CLI.
mkdir "$PREFIX/workspace"
SERVICE_ATTEMPTED=true
AGENT_SECRET="$SECRET" PATH="$NODE_DIR:$PREFIX/bin:$PATH" "$NODE" "$CLI_JS" install --server "$SERVER" --name "$NAME" \
  --yeaft-dir "$PREFIX/data" --work-dir "$PREFIX/workspace" > "$PREFIX/service-install.log" 2>&1 || fail "service installation failed; inspect the private log at $PREFIX/service-install.log"
: > "$PREFIX/.complete"
printf '\nYeaft Agent %s was installed.\nManage it with:\n  %s status --name %s\n' "$NAME" "$(quote "$WRAPPER")" "$NAME"
if [ "$PLATFORM" = linux ]; then
  printf 'To keep the user service running after logout, ask an administrator to enable linger for your account.\n'
fi

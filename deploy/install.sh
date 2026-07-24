#!/usr/bin/env bash
set -euo pipefail

# Installs Daily Care as a systemd service and adds a marked Caddy site block.
APP_NAME="dailycare"
DOMAIN="${DOMAIN:-dailycare.1113112.xyz}"
PORT="${PORT:-3005}"
APP_DIR="${APP_DIR:-/opt/dailycare}"
DATA_DIR="${DATA_DIR:-/var/lib/dailycare}"
CONFIG_DIR="${CONFIG_DIR:-/etc/dailycare}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
ENV_FILE="${CONFIG_DIR}/${APP_NAME}.env"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

if [[ ! -f "$CADDYFILE" ]]; then
  printf 'Caddyfile not found at %s. Set CADDYFILE to the existing file.\n' "$CADDYFILE" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nodejs npm
fi

if ! command -v caddy >/dev/null 2>&1; then
  printf 'Caddy is not installed. Install Caddy first, then run this script again.\n' >&2
  exit 1
fi

install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$CONFIG_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  cp -a "$SOURCE_DIR"/. "$APP_DIR"/
fi
chown -R root:root "$APP_DIR"

if ! id "$APP_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_NAME"
fi
chown -R "$APP_NAME":"$APP_NAME" "$DATA_DIR"

cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if [[ ! -f "$ENV_FILE" ]]; then
  APP_TIMEZONE="${APP_TIMEZONE:-$(timedatectl show --property=Timezone --value 2>/dev/null || true)}"
  APP_TIMEZONE="${APP_TIMEZONE:-UTC}"
  VAPID_KEYS="$(node -e "const w=require('web-push'); process.stdout.write(JSON.stringify(w.generateVAPIDKeys()))")"
  VAPID_PUBLIC_KEY="$(node -e "const k=JSON.parse(process.argv[1]); process.stdout.write(k.publicKey)" "$VAPID_KEYS")"
  VAPID_PRIVATE_KEY="$(node -e "const k=JSON.parse(process.argv[1]); process.stdout.write(k.privateKey)" "$VAPID_KEYS")"
  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
DATA_DIR=${DATA_DIR}
APP_TIMEZONE=${APP_TIMEZONE}
RESET_HOUR=5
VAPID_SUBJECT=mailto:dailycare@${DOMAIN}
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
DEFAULT_MORNING_TIME=08:00
DEFAULT_MIDDAY_TIME=13:00
DEFAULT_EVENING_TIME=21:00
EOF
  chmod 0600 "$ENV_FILE"
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Daily Care PWA
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_NAME}
Group=${APP_NAME}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

if ! grep -Fq "# BEGIN DAILYCARE" "$CADDYFILE"; then
  cat >> "$CADDYFILE" <<EOF

# BEGIN DAILYCARE
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:${PORT}
}
# END DAILYCARE
EOF
fi

caddy validate --config "$CADDYFILE"
systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl restart "$APP_NAME"
systemctl reload caddy || systemctl restart caddy

printf '\nDaily Care is running at https://%s\n' "$DOMAIN"
printf 'Service: %s\n' "$APP_NAME"
printf 'Reminder settings: %s\n' "$ENV_FILE"

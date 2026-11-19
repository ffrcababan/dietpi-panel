#!/usr/bin/env bash
set -euo pipefail

# DietPi Panel Idempotent Installer
# Run as root on DietPi / Debian: sudo ./install.sh [--domain example.com] [--with-certbot]

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DOMAIN=""
WITH_CERTBOT=0

usage() {
    cat <<EOF
Usage: sudo ./install.sh [OPTIONS]

Options:
  --domain <domain>   Base domain (panel.<domain> for dashboard, <app>.<domain> for apps)
  --with-certbot      Run certbot --apache -d panel.<domain> at the end of install
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)
            CLI_DOMAIN="${2:-}"
            shift 2
            ;;
        --with-certbot)
            WITH_CERTBOT=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "${EUID}" -ne 0 ]]; then
    echo "Error: install.sh must be run as root (use sudo ./install.sh)." >&2
    exit 1
fi

log() {
    printf '\033[1;34m[dietpi-panel]\033[0m %s\n' "$1"
}

warn() {
    printf '\033[1;33m[warning]\033[0m %s\n' "$1"
}

# 1. Verify prerequisites
REQUIRED_CMDS=(apache2ctl a2enmod a2ensite a2dissite php node npm sqlite3 openssl systemctl)
for cmd in "${REQUIRED_CMDS[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found. Install Apache, PHP 8.x (pdo_sqlite), Node.js 20+, and SQLite3 first." >&2
        exit 1
    fi
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
    echo "Error: Node.js 20+ is required (detected $(node -v))." >&2
    exit 1
fi

if ! php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);'; then
    echo "Error: PHP pdo_sqlite extension is required (try: apt-get install -y php8.4-sqlite3 && phpenmod pdo pdo_sqlite)." >&2
    exit 1
fi

# 2. Resolve Base Domain
EXISTING_DOMAIN=""
if [[ -f /etc/control-agent/config.env ]]; then
    EXISTING_DOMAIN="$(awk -F= '/^BASE_DOMAIN=/{print $2; exit}' /etc/control-agent/config.env || true)"
fi

TARGET_DOMAIN="${CLI_DOMAIN:-${BASE_DOMAIN:-${EXISTING_DOMAIN:-}}}"
if [[ -z "$TARGET_DOMAIN" ]]; then
    read -r -p "Enter your base domain (e.g. mydomain.com): " TARGET_DOMAIN
fi
TARGET_DOMAIN="$(printf '%s' "$TARGET_DOMAIN" | tr '[:upper:]' '[:lower:]' | xargs)"

if [[ ${#TARGET_DOMAIN} -gt 253 || ! "$TARGET_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
    echo "Error: invalid base domain '$TARGET_DOMAIN'." >&2
    exit 1
fi

log "Configuring DietPi Panel for base domain: ${TARGET_DOMAIN} (dashboard: panel.${TARGET_DOMAIN})"

# 3. Create unprivileged system user 'panel'
if ! id -u panel >/dev/null 2>&1; then
    log "Creating system user 'panel'..."
    useradd --system --user-group --shell /usr/sbin/nologin --home-dir /opt/dietpi-panel --no-create-home panel
fi

# 4. Create directories with least-privilege permissions
mkdir -p /srv/db /srv/db/_panel /srv/db/backups /srv/backups/sites
mkdir -p /var/www/_shared
mkdir -p /etc/apache2/conf-app-db /etc/control-agent /etc/dietpi-panel
mkdir -p /opt/control-agent /opt/dietpi-panel

chmod 0755 /srv/db /var/www/_shared
chown panel:panel /srv/db/_panel
chmod 0750 /srv/db/_panel
chmod 0750 /srv/db/backups /srv/backups/sites /etc/apache2/conf-app-db /etc/control-agent /opt/control-agent
chown root:panel /etc/dietpi-panel
chmod 0750 /etc/dietpi-panel

# 5. Install shared PHP endpoint, bash helper scripts, templates, and control agent
log "Installing shared db.php, bash helpers, templates, and control agent..."
install -m 0644 -o root -g root "${REPO_DIR}/php/db.php" /var/www/_shared/db.php

for script_name in mkdb listdb mksite listsites; do
    install -m 0755 -o root -g root "${REPO_DIR}/scripts/${script_name}" "/usr/local/bin/${script_name}"
done

for tmpl in vhost-static.conf vhost-php.conf vhost-nextjs.conf vhost-dbonly.conf vhost-panel.conf; do
    install -m 0644 -o root -g root "${REPO_DIR}/templates/apache/${tmpl}" "/etc/skel/${tmpl}"
done
install -m 0644 -o root -g root "${REPO_DIR}/templates/systemd/app-nextjs.service.tmpl" /etc/skel/app-nextjs.service.tmpl

install -m 0750 -o root -g root "${REPO_DIR}/control-agent/agent.js" /opt/control-agent/agent.js

# 6. Generate or preserve secrets idempotently
AGENT_SECRET=""
SESSION_SECRET=""
if [[ -f /etc/dietpi-panel/panel.env ]]; then
    AGENT_SECRET="$(awk -F= '/^AGENT_SECRET=/{print $2; exit}' /etc/dietpi-panel/panel.env || true)"
    SESSION_SECRET="$(awk -F= '/^SESSION_SECRET=/{print $2; exit}' /etc/dietpi-panel/panel.env || true)"
fi

if [[ ${#AGENT_SECRET} -lt 32 ]]; then
    AGENT_SECRET="$(openssl rand -hex 32)"
fi
if [[ ${#SESSION_SECRET} -lt 32 ]]; then
    SESSION_SECRET="$(openssl rand -hex 32)"
fi

if [[ -f /etc/control-agent/config.env ]]; then
    if grep -q '^BASE_DOMAIN=' /etc/control-agent/config.env; then
        sed -i "s|^BASE_DOMAIN=.*$|BASE_DOMAIN=${TARGET_DOMAIN}|" /etc/control-agent/config.env
    else
        printf 'BASE_DOMAIN=%s\n' "${TARGET_DOMAIN}" >> /etc/control-agent/config.env
    fi
else
    cat > /etc/control-agent/config.env <<EOF
BASE_DOMAIN=${TARGET_DOMAIN}
# Optional Cloudflare Tunnel (cloudflared) integration:
# Enabled automatically when cloudflared and /etc/cloudflared/config.yml exist.
# CF_ENABLED=auto
# CF_TUNNEL_NAME=dietpipanel
# CF_CONFIG=/etc/cloudflared/config.yml
# CF_SERVICE_URL=http://localhost:80
# CF_UNIT=cloudflared
# TUNNEL_ORIGIN_CERT=/root/.cloudflared/cert.pem
EOF
fi
chown root:root /etc/control-agent/config.env
chmod 0644 /etc/control-agent/config.env

umask 0137
cat > /etc/dietpi-panel/panel.env <<EOF
BASE_DOMAIN=${TARGET_DOMAIN}
AGENT_SECRET=${AGENT_SECRET}
SESSION_SECRET=${SESSION_SECRET}
DB_PATH=/srv/db/_panel/panel.sqlite
AGENT_SOCKET=/run/control-agent.sock
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
EOF
umask 0022
chown root:panel /etc/dietpi-panel/panel.env
chmod 0640 /etc/dietpi-panel/panel.env

# 7. Initialize _panel SQLite DB and default admin user
PANEL_DB="/srv/db/_panel/panel.sqlite"
sqlite3 "$PANEL_DB" <<'SQL'
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
SQL

ADMIN_EXISTS="$(sqlite3 "$PANEL_DB" "SELECT COUNT(*) FROM users WHERE username='admin';")"
if [[ "$ADMIN_EXISTS" == "0" ]]; then
    ADMIN_PASS="${PANEL_ADMIN_PASS:-}"
    if [[ -z "$ADMIN_PASS" ]]; then
        echo ""
        echo "Create the initial 'admin' password (you will be prompted to change it on first web login)."
        while true; do
            read -r -s -p "Initial admin password (min 8 chars): " ADMIN_PASS
            echo ""
            read -r -s -p "Confirm password: " ADMIN_PASS_CONFIRM
            echo ""
            if [[ "$ADMIN_PASS" != "$ADMIN_PASS_CONFIRM" ]]; then
                warn "Passwords do not match. Try again."
                continue
            fi
            if [[ ${#ADMIN_PASS} -lt 8 ]]; then
                warn "Password must be at least 8 characters. Try again."
                continue
            fi
            break
        done
    fi

    ADMIN_HASH="$(INIT_PASS="$ADMIN_PASS" node -e '
      const crypto = require("node:crypto");
      const pw = process.env.INIT_PASS || "";
      const salt = crypto.randomBytes(16).toString("hex");
      const derived = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
      process.stdout.write(`scrypt$16384$8$1$${salt}$${derived}`);
    ')"

    HASH_HEX="$(printf '%s' "$ADMIN_HASH" | od -An -tx1 | tr -d ' \n')"
    sqlite3 "$PANEL_DB" "INSERT INTO users (username, password_hash, must_change_password) VALUES ('admin', CAST(X'${HASH_HEX}' AS TEXT), 1);"
    unset ADMIN_PASS ADMIN_PASS_CONFIRM ADMIN_HASH
    log "Created initial admin user (must_change_password=1)."
else
    log "Existing admin account detected in ${PANEL_DB}; preserving credentials."
fi

chown -R panel:panel /srv/db/_panel
chmod 0640 "$PANEL_DB"

# 8. Install and build Next.js panel app
log "Copying Next.js application to /opt/dietpi-panel..."
tar --exclude=node_modules --exclude=.next -cf - -C "${REPO_DIR}/dietpi-panel" . | tar -xf - -C /opt/dietpi-panel

log "Installing npm dependencies and building Next.js production bundle..."
pushd /opt/dietpi-panel >/dev/null
if [[ -f package-lock.json ]]; then
    NODE_ENV=development npm ci
else
    NODE_ENV=development npm install
fi
NODE_ENV=production npm run build
popd >/dev/null

chown -R panel:panel /opt/dietpi-panel

# 9. Install systemd services
log "Installing systemd services..."
sed "s|^Environment=AGENT_SECRET=.*$|Environment=AGENT_SECRET=${AGENT_SECRET}|" \
    "${REPO_DIR}/control-agent/control-agent.service" > /etc/systemd/system/control-agent.service
chown root:root /etc/systemd/system/control-agent.service
chmod 0600 /etc/systemd/system/control-agent.service

install -m 0644 -o root -g root "${REPO_DIR}/templates/systemd/dietpi-panel.service" /etc/systemd/system/dietpi-panel.service

systemctl daemon-reload
systemctl enable control-agent.service
systemctl restart control-agent.service
systemctl enable dietpi-panel.service
systemctl restart dietpi-panel.service

# 10. Configure Apache modules & panel vhost
log "Configuring Apache2 modules and panel virtual host..."
a2enmod proxy proxy_http headers rewrite ssl >/dev/null

PANEL_VHOST="/etc/apache2/sites-available/dietpi-panel.conf"
if [[ ! -f "$PANEL_VHOST" ]]; then
    sed "s|__BASE_DOMAIN__|${TARGET_DOMAIN}|g" /etc/skel/vhost-panel.conf > "$PANEL_VHOST"
    chmod 0644 "$PANEL_VHOST"
else
    warn "${PANEL_VHOST} already exists; keeping existing Apache vhost configuration."
fi

a2ensite dietpi-panel.conf >/dev/null
apache2ctl configtest >/dev/null
systemctl reload apache2

if [[ "$WITH_CERTBOT" -eq 1 ]]; then
    if command -v certbot >/dev/null 2>&1; then
        log "Running certbot for panel.${TARGET_DOMAIN}..."
        certbot --apache -d "panel.${TARGET_DOMAIN}"
    else
        warn "certbot is not installed; skipping automatic TLS setup."
    fi
fi

echo ""
log "Installation complete!"
echo "------------------------------------------------------------------------"
echo "  Control Agent:  systemctl status control-agent"
echo "  Panel Service:  systemctl status dietpi-panel"
echo "  Panel Vhost:    ${PANEL_VHOST} (panel.${TARGET_DOMAIN})"
echo ""
echo "  Next steps:"
echo "  1. Ensure DNS A/AAAA for panel.${TARGET_DOMAIN} (and *.${TARGET_DOMAIN}) points here."
echo "  2. Enable TLS (required for Secure session cookies):"
echo "       sudo certbot --apache -d panel.${TARGET_DOMAIN}"
echo "  3. Visit https://panel.${TARGET_DOMAIN}, sign in as 'admin', change your"
echo "     initial password on /settings, and optionally enable TOTP 2FA."
echo "------------------------------------------------------------------------"

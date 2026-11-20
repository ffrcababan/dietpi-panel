#!/usr/bin/env bash
set -euo pipefail

# DietPi Panel Cross-Distro Idempotent Installer
# Supports systemd-based Linux distributions:
#   - Debian / Ubuntu / DietPi / Raspberry Pi OS / Armbian (apt)
#   - RHEL / Rocky / AlmaLinux / CentOS Stream / Fedora (dnf/yum)
#   - openSUSE Leap / Tumbleweed / SLES (zypper)
#   - Arch Linux / Manjaro / EndeavourOS (pacman)
#
# Automatically installs missing required stack packages (Apache, PHP + pdo_sqlite,
# Node.js 20+, SQLite3, OpenSSL, Git, Unzip, Python3) unless --skip-packages is passed.
# Run as root: sudo ./install.sh [--domain example.com] [--with-certbot] [--skip-packages]

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DOMAIN=""
WITH_CERTBOT=0
SKIP_PACKAGES=0

usage() {
    cat <<EOF
Usage: sudo ./install.sh [OPTIONS]

Options:
  --domain <domain>   Base domain (panel.<domain> for dashboard, <app>.<domain> for apps)
  --with-certbot      Run certbot --apache -d panel.<domain> at the end of install
  --skip-packages     Skip OS package manager installation (use pre-installed stack)
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
        --skip-packages)
            SKIP_PACKAGES=1
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

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Error: DietPi Panel requires a Linux server host." >&2
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    echo "Error: systemd is required (systemctl / /run/systemd/system not detected). Non-systemd containers/distros like stock Alpine are not supported." >&2
    exit 1
fi

# 1. Detect Linux distro family
DISTRO_ID="unknown"
DISTRO_LIKE=""
if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    DISTRO_ID="$(printf '%s' "${ID:-unknown}" | tr '[:upper:]' '[:lower:]')"
    DISTRO_LIKE="$(printf '%s' "${ID_LIKE:-}" | tr '[:upper:]' '[:lower:]')"
fi

DISTRO_FAMILY="unknown"
case "$DISTRO_ID" in
    debian|ubuntu|dietpi|raspbian|linuxmint|pop|armbian|kali|devuan)
        DISTRO_FAMILY="debian"
        ;;
    rhel|rocky|almalinux|centos|fedora|ol|amzn|scientific)
        DISTRO_FAMILY="rhel"
        ;;
    opensuse*|sles|suse)
        DISTRO_FAMILY="suse"
        ;;
    arch|manjaro|endeavouros|cachyos|garuda)
        DISTRO_FAMILY="arch"
        ;;
    *)
        if [[ " $DISTRO_LIKE " == *" debian "* || " $DISTRO_LIKE " == *" ubuntu "* ]]; then
            DISTRO_FAMILY="debian"
        elif [[ " $DISTRO_LIKE " == *" rhel "* || " $DISTRO_LIKE " == *" fedora "* || " $DISTRO_LIKE " == *" centos "* ]]; then
            DISTRO_FAMILY="rhel"
        elif [[ " $DISTRO_LIKE " == *" suse "* ]]; then
            DISTRO_FAMILY="suse"
        elif [[ " $DISTRO_LIKE " == *" arch "* ]]; then
            DISTRO_FAMILY="arch"
        fi
        ;;
esac

if [[ "$DISTRO_FAMILY" == "unknown" ]]; then
    if command -v apt-get >/dev/null 2>&1; then
        DISTRO_FAMILY="debian"
    elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
        DISTRO_FAMILY="rhel"
    elif command -v zypper >/dev/null 2>&1; then
        DISTRO_FAMILY="suse"
    elif command -v pacman >/dev/null 2>&1; then
        DISTRO_FAMILY="arch"
    fi
fi

# Distro layout defaults
PHP_FPM_SERVICE=""
case "$DISTRO_FAMILY" in
    debian)
        WEB_USER="www-data"
        APACHE_SERVICE="apache2"
        APACHE_CTL="apache2ctl"
        APACHE_DIR="/etc/apache2"
        APACHE_LOG_DIR="/var/log/apache2"
        ;;
    rhel)
        WEB_USER="apache"
        APACHE_SERVICE="httpd"
        APACHE_CTL="apachectl"
        APACHE_DIR="/etc/httpd"
        APACHE_LOG_DIR="/var/log/httpd"
        PHP_FPM_SERVICE="php-fpm"
        ;;
    suse)
        WEB_USER="wwwrun"
        APACHE_SERVICE="apache2"
        APACHE_CTL="apache2ctl"
        APACHE_DIR="/etc/apache2"
        APACHE_LOG_DIR="/var/log/apache2"
        ;;
    arch)
        WEB_USER="http"
        APACHE_SERVICE="httpd"
        APACHE_CTL="apachectl"
        APACHE_DIR="/etc/httpd"
        APACHE_LOG_DIR="/var/log/httpd"
        PHP_FPM_SERVICE="php-fpm"
        ;;
    *)
        if [[ "$SKIP_PACKAGES" -ne 1 ]]; then
            echo "Error: Unsupported Linux distribution '${DISTRO_ID}'. Supported families: Debian/Ubuntu/DietPi, RHEL/Rocky/Alma/Fedora, openSUSE/SLES, Arch/Manjaro (or pass --skip-packages with dependencies pre-installed)." >&2
            exit 1
        fi
        WEB_USER="${WEB_USER:-$(id -u www-data >/dev/null 2>&1 && echo www-data || (id -u apache >/dev/null 2>&1 && echo apache || echo http))}"
        APACHE_SERVICE="${APACHE_SERVICE:-$(systemctl list-unit-files apache2.service >/dev/null 2>&1 && echo apache2 || echo httpd)}"
        APACHE_CTL="${APACHE_CTL:-$(command -v apache2ctl >/dev/null 2>&1 && echo apache2ctl || echo apachectl)}"
        APACHE_DIR="${APACHE_DIR:-$([[ -d /etc/httpd ]] && echo /etc/httpd || echo /etc/apache2)}"
        APACHE_LOG_DIR="${APACHE_LOG_DIR:-$([[ "$APACHE_DIR" == "/etc/httpd" ]] && echo /var/log/httpd || echo /var/log/apache2)}"
        ;;
esac

APACHE_SITES_AVAIL="${APACHE_DIR}/sites-available"
APACHE_SITES_EN="${APACHE_DIR}/sites-enabled"
APACHE_CONF_DB="${APACHE_DIR}/conf-app-db"

node_major_version() {
    if ! command -v node >/dev/null 2>&1; then
        echo 0
        return
    fi
    node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

find_php_bin() {
    local c
    for c in "$(command -v php 2>/dev/null || true)" /usr/bin/php /usr/local/bin/php /usr/bin/php8 /usr/bin/php8.4 /usr/bin/php8.3 /usr/bin/php8.2; do
        if [[ -n "$c" && -x "$c" ]]; then
            echo "$c"
            return 0
        fi
    done
    return 1
}

has_dietpi_apache_conf() {
    [[ -f /etc/apache2/conf-enabled/dietpi.conf || -f /etc/apache2/conf-available/dietpi.conf ]]
}

has_enabled_mod_php() {
    local f
    for f in /etc/apache2/mods-enabled/php*.load; do
        [[ -e "$f" ]] && return 0
    done
    return 1
}

detect_debian_php_fpm() {
    local php_bin ver conf base candidate=""
    php_bin="$(find_php_bin || true)"
    if [[ -n "$php_bin" ]]; then
        ver="$("$php_bin" -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null || true)"
        if [[ -n "$ver" && -f "/etc/apache2/conf-available/php${ver}-fpm.conf" ]] \
           && systemctl list-unit-files "php${ver}-fpm.service" --no-legend 2>/dev/null | grep -q "^php${ver}-fpm\.service"; then
            echo "php${ver}-fpm"
            return 0
        fi
    fi
    for conf in /etc/apache2/conf-available/php*-fpm.conf; do
        [[ -e "$conf" ]] || continue
        base="$(basename "$conf" .conf)"
        if systemctl list-unit-files "${base}.service" --no-legend 2>/dev/null | grep -q "^${base}\.service"; then
            candidate="$base"
        fi
    done
    if [[ -n "$candidate" ]]; then
        echo "$candidate"
        return 0
    fi
    return 1
}

guard_dietpi_mpm_conf() {
    local conf="/etc/apache2/conf-enabled/dietpi.conf"
    [[ -f "$conf" ]] || return 0
    local current_mpm
    current_mpm="$(a2query -M 2>/dev/null || true)"
    [[ "$current_mpm" == "prefork" ]] || return 0
    if grep -Eq '^[[:space:]]*(ThreadsPerChild|ThreadLimit|MinSpareThreads|MaxSpareThreads|AsyncRequestWorkerFactor)\b' "$conf"; then
        warn "Apache is running mpm_prefork while ${conf} defines threaded MPM directives; wrapping them in <IfModule mpm_event_module>."
        local target
        target="$(readlink -f "$conf" 2>/dev/null || echo "$conf")"
        awk '
            BEGIN { in_mpm_ifmod = 0; wrapped = 0 }
            /^[[:space:]]*<IfModule[[:space:]]+mpm_(event|worker)_module>/ {
                if (wrapped) { print "</IfModule>"; wrapped = 0 }
                in_mpm_ifmod = 1
            }
            /^[[:space:]]*<\/IfModule>/ {
                if (wrapped) { print "</IfModule>"; wrapped = 0 }
                in_mpm_ifmod = 0
            }
            {
                if (!in_mpm_ifmod && $0 ~ /^[[:space:]]*(ThreadsPerChild|ThreadLimit|MinSpareThreads|MaxSpareThreads|AsyncRequestWorkerFactor)[[:space:]]+/) {
                    if (!wrapped) { print "<IfModule mpm_event_module>"; wrapped = 1 }
                    print "    " $0
                } else {
                    if (wrapped) { print "</IfModule>"; wrapped = 0 }
                    print $0
                }
            }
            END { if (wrapped) print "</IfModule>" }
        ' "$target" > "${target}.tmp" && chmod 0644 "${target}.tmp" && mv "${target}.tmp" "$target"
    fi
}

install_stack_debian() {
    export DEBIAN_FRONTEND=noninteractive
    log "Installing/verifying required stack via apt (${DISTRO_ID})..."
    apt-get update -y

    local php_apache_pkg="php-fpm"
    if ! has_dietpi_apache_conf && has_enabled_mod_php && ! detect_debian_php_fpm >/dev/null; then
        php_apache_pkg="libapache2-mod-php"
    fi

    local core_pkgs=(
        apache2
        "$php_apache_pkg"
        php-cli
        php-sqlite3
        php-mbstring
        php-xml
        php-curl
        sqlite3
        openssl
        git
        unzip
        tar
        ca-certificates
        python3
        python3-venv
    )
    if ! command -v curl >/dev/null 2>&1; then
        core_pkgs+=(curl)
    fi
    apt-get install -y "${core_pkgs[@]}"

    if (( $(node_major_version) < 20 )); then
        log "Installing Node.js 22.x LTS (required >= 20)..."
        apt-get install -y curl gnupg
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
    fi

    local opt_pkg
    for opt_pkg in composer certbot python3-certbot-apache; do
        apt-get install -y "$opt_pkg" >/dev/null 2>&1 || warn "Optional package '$opt_pkg' unavailable in apt; skipping."
    done
}

install_stack_rhel() {
    local dnf_bin="dnf"
    if ! command -v dnf >/dev/null 2>&1; then
        dnf_bin="yum"
    fi
    log "Installing/verifying required stack via ${dnf_bin} (${DISTRO_ID})..."

    if [[ "$DISTRO_ID" != "fedora" ]]; then
        "$dnf_bin" install -y epel-release >/dev/null 2>&1 || warn "Could not enable epel-release; continuing with base repos."
    fi

    local core_pkgs=(
        httpd
        mod_ssl
        php
        php-cli
        php-fpm
        php-pdo
        php-mbstring
        php-xml
        sqlite
        openssl
        git
        unzip
        tar
        python3
        ca-certificates
    )
    if ! command -v curl >/dev/null 2>&1; then
        core_pkgs+=(curl)
    fi
    "$dnf_bin" install -y "${core_pkgs[@]}"

    if (( $(node_major_version) < 20 )); then
        log "Installing Node.js 22.x LTS (required >= 20)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
        "$dnf_bin" install -y nodejs
    fi

    local opt_pkg
    for opt_pkg in certbot python3-certbot-apache composer policycoreutils-python-utils; do
        "$dnf_bin" install -y "$opt_pkg" >/dev/null 2>&1 || warn "Optional package '$opt_pkg' unavailable; skipping."
    done
}

install_node22_tarball() {
    local arch node_arch ver="v22.14.0"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)   node_arch="x64" ;;
        aarch64|arm64)  node_arch="arm64" ;;
        armv7l|armv7*)  node_arch="armv7l" ;;
        *)
            echo "Error: Unsupported CPU architecture '${arch}' for automatic Node.js binary install." >&2
            return 1
            ;;
    esac
    log "Downloading official Node.js ${ver} (${node_arch}) with SHA-256 verification..."
    local tmp_dir tar_name sums_url tar_url
    tmp_dir="$(mktemp -d)"
    tar_name="node-${ver}-linux-${node_arch}.tar.xz"
    sums_url="https://nodejs.org/dist/${ver}/SHASUMS256.txt"
    tar_url="https://nodejs.org/dist/${ver}/${tar_name}"
    if curl -fsSL "$sums_url" -o "${tmp_dir}/SHASUMS256.txt" && curl -fsSL "$tar_url" -o "${tmp_dir}/${tar_name}"; then
        (cd "$tmp_dir" && grep "  ${tar_name}\$" SHASUMS256.txt | sha256sum -c -)
        tar -xJf "${tmp_dir}/${tar_name}" --strip-components=1 -C /usr/local
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

install_stack_suse() {
    log "Installing/verifying required stack via zypper (${DISTRO_ID})..."
    zypper --non-interactive refresh

    local core_pkgs=(apache2 sqlite3 openssl git unzip tar xz python3 ca-certificates)
    if ! command -v curl >/dev/null 2>&1; then
        core_pkgs+=(curl)
    fi
    zypper --non-interactive install -y "${core_pkgs[@]}"

    if ! zypper --non-interactive install -y apache2-mod_php8 php8 php8-pdo php8-sqlite php8-mbstring php8-curl php8-openssl >/dev/null 2>&1; then
        zypper --non-interactive install -y apache2-mod_php php php-pdo php-sqlite php-mbstring php-curl php-openssl
    fi

    if [[ ! -e /usr/bin/php && -x /usr/bin/php8 ]]; then
        ln -sf /usr/bin/php8 /usr/bin/php
    fi

    if (( $(node_major_version) < 20 )); then
        log "Installing Node.js 20+ via zypper..."
        zypper --non-interactive install -y nodejs22 npm22 >/dev/null 2>&1 \
            || zypper --non-interactive install -y nodejs20 npm20 >/dev/null 2>&1 \
            || zypper --non-interactive install -y nodejs-default npm-default >/dev/null 2>&1 \
            || true
    fi
    if (( $(node_major_version) < 20 )); then
        install_node22_tarball
    fi

    local opt_pkg
    for opt_pkg in certbot python3-certbot-apache php8-composer composer; do
        zypper --non-interactive install -y "$opt_pkg" >/dev/null 2>&1 || true
    done
}

install_stack_arch() {
    log "Installing/verifying required stack via pacman (${DISTRO_ID})..."
    local core_pkgs=(apache php php-sqlite php-fpm sqlite openssl git unzip tar python nodejs npm ca-certificates)
    if ! command -v curl >/dev/null 2>&1; then
        core_pkgs+=(curl)
    fi
    pacman -Sy --noconfirm --needed "${core_pkgs[@]}"

    if [[ -f /etc/php/php.ini ]]; then
        sed -i -E 's/^;(extension=(pdo_sqlite|sqlite3|openssl|curl|mbstring))/\1/' /etc/php/php.ini
    fi

    local opt_pkg
    for opt_pkg in certbot certbot-apache composer; do
        pacman -S --noconfirm --needed "$opt_pkg" >/dev/null 2>&1 || true
    done
}

if [[ "$SKIP_PACKAGES" -eq 0 ]]; then
    log "Detected Linux distribution: ${DISTRO_ID} (family: ${DISTRO_FAMILY})"
    case "$DISTRO_FAMILY" in
        debian) install_stack_debian ;;
        rhel)   install_stack_rhel ;;
        suse)   install_stack_suse ;;
        arch)   install_stack_arch ;;
    esac
else
    log "Skipping OS package installation (--skip-packages)."
fi

# 2. Verify prerequisites
REQUIRED_CMDS=("$APACHE_CTL" node npm sqlite3 openssl systemctl)
for cmd in "${REQUIRED_CMDS[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found after setup." >&2
        exit 1
    fi
done

PHP_BIN="$(find_php_bin || true)"
if [[ -z "$PHP_BIN" ]]; then
    echo "Error: PHP CLI binary not found." >&2
    exit 1
fi

NODE_MAJOR="$(node_major_version)"
if (( NODE_MAJOR < 20 )); then
    echo "Error: Node.js 20+ is required (detected v${NODE_MAJOR})." >&2
    exit 1
fi

if ! "$PHP_BIN" -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);'; then
    echo "Error: PHP pdo_sqlite extension is required ($PHP_BIN missing pdo_sqlite)." >&2
    exit 1
fi

if [[ "$DISTRO_FAMILY" == "debian" && -z "$PHP_FPM_SERVICE" ]]; then
    DEBIAN_FPM="$(detect_debian_php_fpm 2>/dev/null || true)"
    if [[ -n "$DEBIAN_FPM" ]] && { has_dietpi_apache_conf || ! has_enabled_mod_php || a2query -q -c "$DEBIAN_FPM" >/dev/null 2>&1; }; then
        PHP_FPM_SERVICE="$DEBIAN_FPM"
    fi
fi

if ! id -u "$WEB_USER" >/dev/null 2>&1; then
    echo "Error: web server system user '${WEB_USER}' does not exist." >&2
    exit 1
fi
WEB_GROUP="$(id -gn "$WEB_USER")"

# 3. Resolve Base Domain
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

log "Configuring DietPi Panel for base domain: ${TARGET_DOMAIN} (dashboard: panel.${TARGET_DOMAIN}, web user: ${WEB_USER}:${WEB_GROUP}, apache unit: ${APACHE_SERVICE})"

# 4. Create unprivileged system user 'panel'
if ! id -u panel >/dev/null 2>&1; then
    log "Creating system user 'panel'..."
    useradd --system --user-group --shell /usr/sbin/nologin --home-dir /opt/dietpi-panel --no-create-home panel
fi

# 5. Create directories with least-privilege permissions
mkdir -p /srv/db /srv/db/_panel /srv/db/backups /srv/backups/sites
mkdir -p /var/www/_shared
mkdir -p "$APACHE_SITES_AVAIL" "$APACHE_SITES_EN" "$APACHE_CONF_DB" "$APACHE_LOG_DIR"
mkdir -p /etc/control-agent /etc/dietpi-panel /opt/control-agent /opt/dietpi-panel /var/log/dietpi-panel-builds /usr/local/lib/dietpi-panel

chmod 0755 /srv/db /var/www/_shared /usr/local/lib/dietpi-panel
chown panel:panel /srv/db/_panel
chmod 0750 /srv/db/_panel
chmod 0750 /srv/db/backups /srv/backups/sites "$APACHE_CONF_DB" /etc/control-agent /opt/control-agent /var/log/dietpi-panel-builds
chown root:panel /etc/dietpi-panel
chmod 0750 /etc/dietpi-panel

# 6. Install shared PHP endpoint, bash helper scripts, templates, and control agent
log "Installing shared db.php, bash helpers, templates, and control agent..."
install -m 0644 -o root -g root "${REPO_DIR}/php/db.php" /var/www/_shared/db.php

for script_name in mkdb listdb mksite listsites; do
    install -m 0755 -o root -g root "${REPO_DIR}/scripts/${script_name}" "/usr/local/bin/${script_name}"
done

for tmpl in vhost-static.conf vhost-php.conf vhost-laravel.conf vhost-spa.conf vhost-proxy.conf vhost-nextjs.conf vhost-dbonly.conf vhost-panel.conf; do
    install -m 0644 -o root -g root "${REPO_DIR}/templates/apache/${tmpl}" "/etc/skel/${tmpl}"
done
install -m 0644 -o root -g root "${REPO_DIR}/templates/systemd/app-nextjs.service.tmpl" /etc/skel/app-nextjs.service.tmpl
install -m 0644 -o root -g root "${REPO_DIR}/templates/systemd/app-service.tmpl" /etc/skel/app-service.tmpl

install -m 0750 -o root -g root "${REPO_DIR}/control-agent/agent.js" /opt/control-agent/agent.js
install -m 0644 -o root -g root "${REPO_DIR}/control-agent/db-studio.php" /usr/local/lib/dietpi-panel/db-studio.php

# 7. Generate or preserve secrets and write cross-distro environment configs
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

upsert_env_kv() {
    local file="$1"
    local key="$2"
    local val="$3"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed -i "s|^${key}=.*$|${key}=${val}|" "$file"
    else
        printf '%s=%s\n' "$key" "$val" >> "$file"
    fi
}

if [[ ! -f /etc/control-agent/config.env ]]; then
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

upsert_env_kv /etc/control-agent/config.env BASE_DOMAIN "$TARGET_DOMAIN"
upsert_env_kv /etc/control-agent/config.env WEB_USER "$WEB_USER"
upsert_env_kv /etc/control-agent/config.env WEB_GROUP "$WEB_GROUP"
upsert_env_kv /etc/control-agent/config.env APACHE_SERVICE "$APACHE_SERVICE"
upsert_env_kv /etc/control-agent/config.env APACHE_CTL "$APACHE_CTL"
upsert_env_kv /etc/control-agent/config.env APACHE_DIR "$APACHE_DIR"
upsert_env_kv /etc/control-agent/config.env APACHE_SITES_AVAIL "$APACHE_SITES_AVAIL"
upsert_env_kv /etc/control-agent/config.env APACHE_SITES_EN "$APACHE_SITES_EN"
upsert_env_kv /etc/control-agent/config.env APACHE_CONF_DB "$APACHE_CONF_DB"
if [[ -n "$PHP_FPM_SERVICE" ]]; then
    upsert_env_kv /etc/control-agent/config.env PHP_FPM_SERVICE "$PHP_FPM_SERVICE"
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
APACHE_SERVICE=${APACHE_SERVICE}
WEB_USER=${WEB_USER}
EOF
umask 0022
chown root:panel /etc/dietpi-panel/panel.env
chmod 0640 /etc/dietpi-panel/panel.env

# 8. Initialize _panel SQLite DB and default admin user
PANEL_DB="/srv/db/_panel/panel.sqlite"
sqlite3 "$PANEL_DB" <<'SQL'
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS resource_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('site', 'database')),
  resource_name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(resource_type, resource_name),
  FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_resource_owners_owner ON resource_owners(owner_user_id);
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
    sqlite3 "$PANEL_DB" "INSERT INTO users (username, display_name, role, is_active, password_hash, must_change_password) VALUES ('admin', 'Administrator', 'admin', 1, CAST(X'${HASH_HEX}' AS TEXT), 1);"
    unset ADMIN_PASS ADMIN_PASS_CONFIRM ADMIN_HASH
    log "Created initial admin user (must_change_password=1)."
else
    log "Existing admin account detected in ${PANEL_DB}; preserving credentials."
fi

chown -R panel:panel /srv/db/_panel
chmod 0640 "$PANEL_DB"

# 9. Install and build Next.js panel app
log "Copying Next.js application to /opt/dietpi-panel..."
rm -rf /opt/dietpi-panel/src /opt/dietpi-panel/public /opt/dietpi-panel/.next
tar --exclude=node_modules --exclude=.next -cf - -C "${REPO_DIR}/dietpi-panel" . | tar -xf - -C /opt/dietpi-panel

log "Installing npm dependencies and building Next.js production bundle..."
pushd /opt/dietpi-panel >/dev/null
if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund
else
    npm install --omit=dev --no-audit --no-fund
fi
NODE_ENV=production npm run build
popd >/dev/null

chown -R panel:panel /opt/dietpi-panel

# 10. Install systemd services
log "Installing systemd services..."
sed -e "s|^Environment=AGENT_SECRET=.*$|Environment=AGENT_SECRET=${AGENT_SECRET}|" \
    -e "s|__APACHE_SERVICE__|${APACHE_SERVICE}|g" \
    "${REPO_DIR}/control-agent/control-agent.service" > /etc/systemd/system/control-agent.service
chown root:root /etc/systemd/system/control-agent.service
chmod 0600 /etc/systemd/system/control-agent.service

install -m 0644 -o root -g root "${REPO_DIR}/templates/systemd/dietpi-panel.service" /etc/systemd/system/dietpi-panel.service

systemctl daemon-reload
systemctl enable control-agent.service
systemctl restart control-agent.service
systemctl enable dietpi-panel.service
systemctl restart dietpi-panel.service

APACHE_NEEDS_RESTART=0

configure_apache_debian() {
    if [[ -n "$PHP_FPM_SERVICE" && -f "/etc/apache2/conf-available/${PHP_FPM_SERVICE}.conf" ]]; then
        local modload modname current_mpm mpm
        current_mpm="$(a2query -M 2>/dev/null || true)"
        for modload in /etc/apache2/mods-enabled/php*.load; do
            [[ -e "$modload" ]] || continue
            modname="$(basename "$modload" .load)"
            log "Disabling mod_php (${modname}) for ${PHP_FPM_SERVICE} + mpm_event..."
            a2dismod "$modname" >/dev/null || true
            APACHE_NEEDS_RESTART=1
        done
        if [[ "$current_mpm" != "event" ]]; then
            for mpm in mpm_prefork mpm_worker; do
                a2dismod "$mpm" >/dev/null 2>&1 || true
            done
            a2enmod mpm_event >/dev/null || true
            APACHE_NEEDS_RESTART=1
        fi
        a2enmod proxy proxy_http proxy_fcgi setenvif headers rewrite ssl env dir mime >/dev/null || true
        a2enconf "$PHP_FPM_SERVICE" >/dev/null || true
        systemctl enable --now "$PHP_FPM_SERVICE"
    else
        a2enmod proxy proxy_http headers rewrite ssl env dir mime >/dev/null || true
    fi
    guard_dietpi_mpm_conf
}

# 11. Configure Apache modules, distro base include, SELinux, firewall, and panel vhost
log "Configuring Apache HTTP server (${APACHE_SERVICE})..."
if [[ "$DISTRO_FAMILY" == "debian" ]]; then
    configure_apache_debian
elif [[ "$DISTRO_FAMILY" == "suse" ]]; then
    if command -v a2enmod >/dev/null 2>&1; then
        for mod in proxy proxy_http headers rewrite ssl env dir mime php8 php php7; do
            a2enmod "$mod" >/dev/null 2>&1 || true
        done
    fi
    cat > /etc/apache2/conf.d/00-dietpi-panel-base.conf <<EOF
Define APACHE_LOG_DIR ${APACHE_LOG_DIR}
IncludeOptional ${APACHE_SITES_EN}/*.conf
EOF
    chmod 0644 /etc/apache2/conf.d/00-dietpi-panel-base.conf
elif [[ "$DISTRO_FAMILY" == "rhel" ]]; then
    cat > /etc/httpd/conf.d/00-dietpi-panel-base.conf <<EOF
Define APACHE_LOG_DIR ${APACHE_LOG_DIR}
IncludeOptional ${APACHE_SITES_EN}/*.conf
EOF
    chmod 0644 /etc/httpd/conf.d/00-dietpi-panel-base.conf
    if systemctl list-unit-files php-fpm.service >/dev/null 2>&1; then
        systemctl enable --now php-fpm
    fi
elif [[ "$DISTRO_FAMILY" == "arch" ]]; then
    HTTPD_CONF="/etc/httpd/conf/httpd.conf"
    if [[ -f "$HTTPD_CONF" ]]; then
        for mod in proxy_module proxy_http_module proxy_fcgi_module headers_module rewrite_module ssl_module socache_shmcb_module env_module unixd_module; do
            sed -i -E "s|^#\s*(LoadModule\s+${mod}\s+.*)|\1|" "$HTTPD_CONF"
        done
        if ! grep -q 'conf/extra/dietpi-panel-base.conf' "$HTTPD_CONF"; then
            printf '\nInclude conf/extra/dietpi-panel-base.conf\n' >> "$HTTPD_CONF"
        fi
    fi
    cat > /etc/httpd/conf/extra/dietpi-panel-base.conf <<EOF
Define APACHE_LOG_DIR ${APACHE_LOG_DIR}
<FilesMatch "\.php$">
    SetHandler "proxy:unix:/run/php-fpm/php-fpm.sock|fcgi://localhost"
</FilesMatch>
DirectoryIndex index.php index.html
IncludeOptional ${APACHE_SITES_EN}/*.conf
EOF
    chmod 0644 /etc/httpd/conf/extra/dietpi-panel-base.conf
    if systemctl list-unit-files php-fpm.service >/dev/null 2>&1; then
        systemctl enable --now php-fpm
    fi
fi

# Apply SELinux rules if enforcing/permissive (e.g. RHEL / Rocky / Alma / Fedora)
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null || echo Disabled)" != "Disabled" ]]; then
    log "Applying SELinux policies for Apache reverse proxy & SQLite..."
    setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 || true
    if command -v semanage >/dev/null 2>&1 && command -v restorecon >/dev/null 2>&1; then
        semanage fcontext -a -t httpd_sys_rw_content_t '/srv/db(/.*)?' >/dev/null 2>&1 || semanage fcontext -m -t httpd_sys_rw_content_t '/srv/db(/.*)?' >/dev/null 2>&1 || true
        semanage fcontext -a -t httpd_sys_rw_content_t '/var/www(/.*)?' >/dev/null 2>&1 || semanage fcontext -m -t httpd_sys_rw_content_t '/var/www(/.*)?' >/dev/null 2>&1 || true
        restorecon -R /srv/db /var/www >/dev/null 2>&1 || true
    elif command -v chcon >/dev/null 2>&1; then
        chcon -R -t httpd_sys_rw_content_t /srv/db /var/www >/dev/null 2>&1 || true
    fi
fi

# Open HTTP/HTTPS ports if firewalld is active
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    log "Opening HTTP/HTTPS in firewalld..."
    firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
fi

PANEL_VHOST="${APACHE_SITES_AVAIL}/dietpi-panel.conf"
if [[ ! -f "$PANEL_VHOST" ]]; then
    sed "s|__BASE_DOMAIN__|${TARGET_DOMAIN}|g" /etc/skel/vhost-panel.conf > "$PANEL_VHOST"
    chmod 0644 "$PANEL_VHOST"
else
    sed -i 's/^[[:space:]]*ProxyTimeout 120$/    ProxyTimeout 600/' "$PANEL_VHOST" || true
    if [[ -f "${APACHE_SITES_AVAIL}/dietpi-panel-le-ssl.conf" ]]; then
        sed -i 's/^[[:space:]]*ProxyTimeout 120$/    ProxyTimeout 600/' "${APACHE_SITES_AVAIL}/dietpi-panel-le-ssl.conf" || true
    fi
    warn "${PANEL_VHOST} already exists; keeping existing Apache vhost configuration."
fi

if command -v a2ensite >/dev/null 2>&1 && [[ "$DISTRO_FAMILY" == "debian" ]]; then
    a2ensite dietpi-panel.conf >/dev/null
else
    ln -sfn "../sites-available/dietpi-panel.conf" "${APACHE_SITES_EN}/dietpi-panel.conf"
fi

"$APACHE_CTL" configtest >/dev/null
systemctl enable "$APACHE_SERVICE" >/dev/null 2>&1 || true
if systemctl is-active --quiet "$APACHE_SERVICE"; then
    if [[ "${APACHE_NEEDS_RESTART:-0}" -eq 1 ]]; then
        systemctl restart "$APACHE_SERVICE"
    else
        systemctl reload "$APACHE_SERVICE"
    fi
else
    systemctl start "$APACHE_SERVICE"
fi

if [[ "$WITH_CERTBOT" -eq 1 ]]; then
    if command -v certbot >/dev/null 2>&1; then
        log "Running certbot for panel.${TARGET_DOMAIN}..."
        certbot --apache -d "panel.${TARGET_DOMAIN}"
    else
        warn "certbot is not installed; skipping automatic TLS setup."
    fi
fi

echo ""
log "Installation complete (${DISTRO_ID} / ${DISTRO_FAMILY})!"
echo "------------------------------------------------------------------------"
echo "  Control Agent:  systemctl status control-agent"
echo "  Panel Service:  systemctl status dietpi-panel"
echo "  Web Server:     systemctl status ${APACHE_SERVICE} (user: ${WEB_USER})"
echo "  Panel Vhost:    ${PANEL_VHOST} (panel.${TARGET_DOMAIN})"
echo ""
echo "  Next steps:"
echo "  1. Ensure DNS A/AAAA for panel.${TARGET_DOMAIN} (and *.${TARGET_DOMAIN}) points here."
echo "  2. Enable TLS (required for Secure session cookies):"
echo "       sudo certbot --apache -d panel.${TARGET_DOMAIN}"
echo "  3. Visit https://panel.${TARGET_DOMAIN}, sign in as 'admin', change your"
echo "     initial password on /account, and optionally enable TOTP 2FA."
echo "------------------------------------------------------------------------"

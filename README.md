# DietPi Panel

A self-hosted server, web application, and SQLite database control panel inspired by the Cloudflare dashboard. Built with **Next.js 14 (App Router, React, TypeScript, Tailwind CSS)** backed by a privileged Node.js control daemon (**systemd** Unix socket) and isolated PHP/Apache runtimes.

---

## Table of Contents

- [Core Features](#core-features)
- [Supported Linux Distributions](#supported-linux-distributions)
- [System Architecture & File Layout](#system-architecture--file-layout)
- [Installation Guide](#installation-guide)
- [Upgrading an Existing Installation](#upgrading-an-existing-installation)
- [How to Use DietPi Panel](#how-to-use-dietpi-panel)
  - [1. Signing In, Account & 2FA](#1-signing-in-account--2fa)
  - [2. Managing Users & Access Control](#2-managing-users--access-control)
  - [3. Hosting Websites & Apps (`/sites`)](#3-hosting-websites--apps-sites)
  - [4. Managing Databases & Database Studio (`/databases`)](#4-managing-databases--database-studio-databases)
  - [5. Using the D1-Style HTTP Database Endpoint (`/db.php`)](#5-using-the-d1-style-http-database-endpoint-dbphp)
  - [6. System Services, Logs & Cloudflare Tunnels](#6-system-services-logs--cloudflare-tunnels)
- [Security Model](#security-model)
- [Backup, Restore & Troubleshooting](#backup-restore--troubleshooting)

---

## Core Features

- **Collapsible Sidebar Navigation**: Desktop sidebar collapses (`Ctrl+B` / `Cmd+B` or header toggle) with persistent preference in `localStorage` and responsive mobile drawer support.
- **Multi-User RBAC & Authentication**:
  - Two roles: `admin` (full system, user management, services, logs, settings, and all resources) and `user` (creates and manages their own sites & databases, isolated from other users' resources).
  - `scrypt` password hashing, HMAC-SHA256 HTTP-only sessions, per-session CSRF protection, login/2FA rate limiting (with Cloudflare/Apache loopback forwarding support), and optional RFC 6238 TOTP Two-Factor Authentication with QR code setup.
- **Sites & App Workspaces (`/sites` & `/sites/[name]`)**:
  - Supports **Static**, **PHP**, **Laravel** (`/public` docroot), **React**, **Vue**, **Astro**, **SvelteKit**, **Next.js**, **Node.js**, and **Python** apps.
  - Jailed web file manager under `/var/www/<name>` with inline code editor, permissions inspector/editor (`chmod`), create/rename/delete, and drag-and-drop / chunked uploads (up to 100 MB with `.zip` extraction).
  - Automatic framework permission hardening (e.g., Laravel `storage/` and `bootstrap/cache/` `0775`, `.env*` `0640`, executable binaries `0755` including `.bin/*` symlink targets, remaining dirs `0755` and files `0644`).
  - Built-in Git `clone` / `pull` with encrypted/root-owned Personal Access Token (PAT) storage (`0600 root:root`) for private repositories (tokens are masked from UI responses and sanitized in build logs).
  - One-click preset build pipelines (`composer install`, `npm ci`/`build`, `php artisan migrate`/`cache`, `systemd` service restarts for runtime apps) plus optional filesystem watcher auto-builds.
- **Built-in SQLite Database Studio (`/databases` & `/databases/[name]`)**:
  - Provisions WAL-mode SQLite databases (`/srv/db/<name>/data.sqlite`) and D1-style HTTP `/db.php` endpoints with reveal-once 256-bit API keys.
  - Interactive **Rows & Data** browser: live debounced search across all columns, sorting, pagination, insert/update/delete rows (supports ROWID tables, composite PKs, `WITHOUT ROWID`, and BLOB preservation), **Row Inspector** with JSON pretty-formatting & clipboard copy, and CSV/JSON exports.
  - **Columns & Structure** inspector/editor: create tables, add/rename/re-type/drop columns atomically inside transactions (preserving indexes, inline/composite `UNIQUE` constraints, foreign keys, triggers, and `NOT NULL` PK rules), view indexes/FKs/triggers, and copy table DDL.
  - **SQL Script Workbench**: multi-statement SQLite execution with transaction rollback toggle, saved per-DB query history, destructive statement confirmation prompts (`DROP`, `TRUNCATE`, mass `DELETE`/`UPDATE`), CSV/JSON downloads, and dangerous SQL guards (`ATTACH`, `load_extension`).
- **Cloudflare Tunnel (`cloudflared`) Auto-Routing & Let's Encrypt TLS**:
  - Automatically registers DNS routes and Apache ingress rules in `/etc/cloudflared/config.yml` when `cloudflared` is present, and issues/renews SSL certificates via Certbot (`--apache`).

---

## Supported Linux Distributions

**Requirements**: A Linux host running **`systemd`** (`systemctl` + `/run/systemd/system`) as `root` (or `sudo`). Non-Linux hosts and non-systemd Linux containers (e.g., stock Alpine Linux with OpenRC) are not supported.

Running `install.sh` automatically detects `/etc/os-release` and installs any missing stack prerequisites (**Apache**, **PHP 8 + `pdo_sqlite`**, **Node.js 20+ / 22 LTS**, **SQLite3**, **OpenSSL**, **Git**, **Unzip**, **Python3**, plus optional **Composer** & **Certbot**):

| Linux Family | Package Manager | Apache Service & Config Dir | Web Runtime User | PHP Integration | Extra OS Automation |
|---|---|---|---|---|---|
| **Debian / Ubuntu / DietPi / Raspberry Pi OS / Armbian** | `apt-get` | `apache2` (`/etc/apache2`) | `www-data` | `libapache2-mod-php` + `php-sqlite3` | Enables `a2enmod` (`proxy`, `proxy_http`, `headers`, `rewrite`, `ssl`, `env`, `dir`, `mime`); NodeSource 22.x if Node < 20 |
| **RHEL / Rocky / AlmaLinux / Fedora / CentOS Stream** | `dnf` / `yum` | `httpd` (`/etc/httpd`) | `apache` | `php` + `php-fpm` + `php-pdo` | Writes `00-dietpi-panel-base.conf`, enables `php-fpm`, opens HTTP/HTTPS in **`firewalld`**, sets **SELinux** `httpd_can_network_connect` & `httpd_sys_rw_content_t` on `/srv/db` and `/var/www` |
| **openSUSE Leap / Tumbleweed / SLES** | `zypper` | `apache2` (`/etc/apache2`) | `wwwrun` | `apache2-mod_php8` + `php8-sqlite` | Enables Apache modules, configures `00-dietpi-panel-base.conf`, falls back to verified Node 22 binary tarball if zypper Node < 20 |
| **Arch Linux / Manjaro / EndeavourOS** | `pacman` | `httpd` (`/etc/httpd`) | `http` | `php` + `php-sqlite` + `php-fpm` | Uncomments `pdo_sqlite`/`sqlite3`/`openssl`/`curl`/`mbstring` in `/etc/php/php.ini`, enables required `LoadModule` entries in `httpd.conf`, wires `php-fpm` + `dietpi-panel-base.conf` |

---

## System Architecture & File Layout

```text
Browser (Next.js App Router UI)
  │  HTTPS (Apache / Certbot TLS / optional Cloudflare Tunnel)
  ▼
Apache Reverse Proxy (panel.<domain> -> http://127.0.0.1:3000)
  │
  ▼
Next.js Dashboard (/opt/dietpi-panel, runs as unprivileged `panel` user)
  ├── /srv/db/_panel/panel.sqlite  (users, scrypt hashes, 2FA TOTP secrets, resource ownership)
  ├── Local Unix Socket (/run/control-agent.sock, root:panel 0660 + AGENT_SECRET)
  ▼
Control Agent (/opt/control-agent/agent.js, systemd, runs as `root`)
  ├── Shell-free binary execution (execFile / spawn with shell: false)
  ├── /etc/control-agent/config.env     (BASE_DOMAIN, WEB_USER, APACHE_*, CF_* config)
  ├── /usr/local/lib/dietpi-panel/db-studio.php  (runs as WEB_USER for Database Studio)
  ├── /var/log/control-agent.log        (action audit log)
  └── /usr/local/bin/{mksite,mkdb,listdb,listsites}
```

| Path | Purpose |
|---|---|
| `/opt/dietpi-panel` | Compiled Next.js application (`panel:panel`) |
| `/opt/control-agent/agent.js` | Privileged control daemon (`0750 root:root`) |
| `/usr/local/lib/dietpi-panel/db-studio.php` | SQLite Database Studio PDO worker executed as web user (`0644 root:root`) |
| `/etc/dietpi-panel/panel.env` | Next.js secrets & DB/Apache config (`0640 root:panel`) |
| `/etc/control-agent/config.env` | Distro-detected Apache/web-user paths, `BASE_DOMAIN`, Cloudflare Tunnel settings |
| `/etc/control-agent/git-tokens/` | Root-only stored Git PAT tokens (`0600 root:root`) |
| `/srv/db/_panel/panel.sqlite` | Panel auth & RBAC SQLite database (`0640 panel:panel`) |
| `/srv/db/<name>/data.sqlite` | Hosted app WAL-mode SQLite databases (`<WEB_USER>:<WEB_GROUP>`) |
| `/var/www/<site>` | Hosted site roots (`<WEB_USER>:<WEB_GROUP>`) |
| `/var/www/_shared/db.php` | Shared D1-style SQLite HTTP endpoint symlinked into sites/DBs |

---

## Installation Guide

### Fresh Server Install

1. **Clone the repository** onto your Linux server:
   ```bash
   git clone https://github.com/ffrcababan/dietpi-panel.git DietpiPanel
   cd DietpiPanel
   ```

2. **Run the installer as `root`** (installs any missing OS stack automatically, builds Next.js, initializes SQLite auth, configures Apache & systemd):
   ```bash
   sudo bash install.sh
   ```

   **Available flags**:
   ```bash
   sudo bash install.sh --domain example.com       # Skip interactive domain prompt
   sudo bash install.sh --with-certbot             # Automatically run certbot for panel.<domain>
   sudo bash install.sh --skip-packages            # Skip OS package manager (use pre-installed stack)
   ```

   For unattended initial setup, you can pre-set the initial `admin` password via environment variable:
   ```bash
   sudo PANEL_ADMIN_PASS="YourStrongPass123!" bash install.sh --domain example.com
   ```

3. **Configure DNS**: Point `panel.<domain>` (and `<app>.<domain>` or wildcard `*.<domain>`) DNS `A`/`AAAA` records (or your Cloudflare Tunnel) to the server.

4. **Enable HTTPS / TLS** *(required in production because session cookies carry the `Secure` attribute)*:
   ```bash
   sudo certbot --apache -d panel.<domain>
   ```
   *(If accessing strictly behind an upstream TLS-terminating Cloudflare Tunnel terminating HTTPS to `http://localhost:80`, ensure `X-Forwarded-Proto: https` is forwarded.)*

5. **First Login**: Open `https://panel.<domain>`, sign in as `admin`, change the temporary password on **My Account** (`/account`), and enable TOTP 2FA.

### Optional: Restrict Panel Access by IP

Inside your HTTPS panel virtual host (`/etc/apache2/sites-available/dietpi-panel-le-ssl.conf` on Debian/SUSE or `/etc/httpd/...` on RHEL/Arch), restrict access inside `<VirtualHost *:443>`:

```apache
<Location "/">
    Require ip 192.168.1.0/24 10.0.0.0/8 100.64.0.0/10
</Location>
```

Then validate and reload Apache:

```bash
# Debian / Ubuntu / DietPi / openSUSE:
sudo apache2ctl configtest && sudo systemctl reload apache2

# RHEL / Rocky / Alma / Fedora / Arch:
sudo apachectl configtest && sudo systemctl reload httpd
```

---

## Upgrading an Existing Installation

No manual database migrations are needed. Re-running `install.sh` preserves `/etc/dietpi-panel/panel.env` secrets, `/etc/control-agent/config.env` domain/tunnel settings, your `/srv/db/_panel/panel.sqlite` users, and all hosted site/database data, while [`ensureSchema`](file:///d:/Dev%20Apps/DietpiPanel/DietpiPanel/dietpi-panel/src/lib/db.ts) automatically applies any schema additions on startup:

```bash
# Optional safety backup before upgrading
sudo sqlite3 /srv/db/_panel/panel.sqlite ".backup '/tmp/panel-backup.sqlite'"

# Pull latest changes and re-run installer
cd /path/to/DietpiPanel && git pull && sudo bash install.sh
```

---

## How to Use DietPi Panel

### 1. Signing In, Account & 2FA

- Open `https://panel.<domain>/login` (click the eye icon to toggle password visibility).
- If prompted with `mustChangePassword`, you are routed to `/account` to set a strong password (minimum 12 characters).
- On **`/account`**, every user can update their display name, email, username, and password, scan a TOTP QR code (Google Authenticator, Authy, 1Password, Bitwarden, etc.) to enable 2FA, or disable 2FA with password + code verification.
- Desktop users can press `Ctrl+B` (`Cmd+B`) or click the sidebar header button to collapse/expand the navigation bar.

### 2. Managing Users & Access Control

- **Admin (`Users` → `/users`)**:
  - Create new `admin` or `user` accounts (with temporary password generation & forced password change option).
  - Click a user to edit details (`/users/[id]`), reset passwords, toggle account active status, change roles, inspect owned site/DB counts, or delete accounts (deleting a user revokes sessions immediately via `session_version`).
- **Standard Users (`user` role)**:
  - Can create and manage their **own** sites and databases, upload files, run Database Studio, and configure SSL/Git/builds on resources they own.
  - Cannot view or modify other users' sites/databases or access admin pages (`/users`, `/services`, `/logs`, `/settings`).

### 3. Hosting Websites & Apps (`/sites`)

1. Click **Create Site** on `/sites`, choose a lowercase slug (`a-z`, `0-9`, `-`), framework preset (`static`, `php`, `laravel`, `react`, `vue`, `astro`, `sveltekit`, `nextjs`, `node`, `python`), optional custom domain, and whether to auto-provision a linked SQLite database (plus auto-seeding `.env` / `.env.local` for framework apps).
2. Click **Manage** (or the site name) to open `/sites/[name]`:
   - **Files & Editor tab**:
     - Browse directories, edit source/env files directly, create files/folders, rename, delete, or adjust octal permissions (`chmod`, never `0777`).
     - Click **Upload Web App** (or drag files/folders directly) to upload single files, multiple files, built folders (`dist/`, `build/`, `out/`), or `.zip` archives up to 100 MB (streamed in 2 MB chunks and extracted safely with automatic ownership/permission normalization).
     - Click **Fix Permissions** anytime to normalize ownership and framework-safe modes across the site.
   - **Git, Builds & SSL tab**:
     - Clone a public or private HTTPS Git repository. For private repositories, enter a **Personal Access Token (PAT)** and optionally save it to root-only storage (`/etc/control-agent/git-tokens/`) for one-click future `Pull` / auto-builds.
     - Click **Run Build** to execute the preset pipeline, toggle **Auto-Build Watcher** to rebuild automatically on SFTP/SSH file changes, inspect recent build logs, or issue Let's Encrypt HTTPS certificates (`Issue TLS Certificate`).

### 4. Managing Databases & Database Studio (`/databases`)

1. Click **Create Database** on `/databases` to provision `/srv/db/<name>/data.sqlite` (WAL mode) + `/db.php` endpoint. Save the **API key** shown in the reveal-once modal if external apps will connect via HTTP.
2. Click a database name (or **Manage**) to open the **Built-in Database Studio** (`/databases/[name]`):
   - **Tables & Views Sidebar**: Search/filter tables and views, see row & column counts, create new tables (`+ Table`), or drop existing objects.
   - **Rows & Data tab**: Live-search across all columns, sort by clicking any column header, insert new rows, edit existing rows, click any cell/row (or the eye icon) to inspect unclipped values & auto-formatted JSON in **Row Inspector**, bulk-select rows to delete, paginate (`25`/`50`/`100`/`200` rows), or export the visible page as **CSV** / **JSON**.
   - **Columns & Structure tab**: Inspect table KPIs, add/rename/re-type/drop columns cleanly, inspect **Indexes & Unique Constraints**, **Foreign Keys**, **Triggers**, and copy the full `CREATE TABLE` DDL.
   - **SQL Script Workbench tab**: Write and execute multi-statement SQLite scripts (`Ctrl+Enter`), optionally wrapped in a rollback-safe transaction, insert starter SQL snippets, recall recent per-DB queries, review confirmation prompts before destructive statements (`DROP`, `TRUNCATE`, unbounded `DELETE`/`UPDATE`), and export query result sets as **CSV** or **JSON**.

### 5. Using the D1-Style HTTP Database Endpoint (`/db.php`)

Every provisioned database exposes `https://<name>.<domain>/db.php` (configured via `SetEnv APP_DB_PATH` + `SetEnv APP_API_KEY` inside Apache `conf-app-db/<name>.conf`):

```bash
curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT)"}'

curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"INSERT INTO items (title) VALUES (?)", "params":["Hello"]}'

curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"SELECT * FROM items"}'
```

Responses:
- Queries (`SELECT`, `WITH ... SELECT`, `PRAGMA`, `RETURNING`): `{"results":[...]}`
- Mutations / DDL: `{"changes":1}`
- Errors: `{"error":"..."}`

### 6. System Services, Logs & Cloudflare Tunnels

- **Services (`/services`)**: Admins can monitor and restart Apache (`apache2` or `httpd`), `control-agent`, `dietpi-panel`, `php-fpm` (if enabled), `cloudflared` (when configured), and `app-<site>.service` runtimes.
- **Logs (`/logs`)**: View recent `journalctl` output for any allowed service with configurable line counts and auto-refresh.
- **Cloudflare Tunnel (`cloudflared`)**: If `cloudflared` and `/etc/cloudflared/config.yml` exist on the host, site/database creation and deletion automatically add/remove `# dietpi-panel:managed` ingress rules, validate the config, and reload `cloudflared`. Customize `CF_*` values in `/etc/control-agent/config.env`.

---

## Security Model

1. **Privilege Separation**:
   - The web panel runs unprivileged as `panel` under systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges=yes`, write access limited to `/srv/db/_panel`).
   - `/run/control-agent.sock` is `0660 root:panel` plus `AGENT_SECRET` authentication, isolating hosted apps (`www-data`/`apache`/`http`/`wwwrun`) from the privileged control daemon.
   - Database API secrets (`conf-app-db/*.conf`) and Git PAT tokens (`/etc/control-agent/git-tokens/*`) are `0600 root:root`.
2. **No Shell Injection**:
   - `control-agent/agent.js` invokes every binary via `execFile`/`spawn` with `shell: false`.
   - File operations validate jailed paths via `lstat` / `realpathSync` to block symlink escapes and protect `/db.php`.
3. **Database Studio Hardening**:
   - Executed by `db-studio.php` under the unprivileged web runtime user with PDO prepared statements, identifier regex/quoting, read-only SQL/script transaction options, and blocked `ATTACH` / `load_extension` statements.

---

## Backup, Restore & Troubleshooting

### Soft-Deleted Resources
- Deleted databases are archived (not purged) to `/srv/db/backups/trash-<name>-<timestamp>/`.
- Deleted sites are archived to `/srv/backups/sites/<name>-<timestamp>/`.

### Safe Live SQLite Backups
Always use SQLite's online `.backup` command rather than `cp` while WAL writes may be active:

```bash
sudo sqlite3 /srv/db/myapp/data.sqlite ".backup '/srv/db/backups/myapp-$(date +%F).sqlite'"
sudo sqlite3 /srv/db/_panel/panel.sqlite ".backup '/srv/db/backups/panel-$(date +%F).sqlite'"
```

### Restore a Database

```bash
# Replace apache2 / www-data with httpd / apache (RHEL/Fedora) or httpd / http (Arch) if applicable
sudo systemctl stop apache2
sudo cp /srv/db/backups/myapp-2026-11-20.sqlite /srv/db/myapp/data.sqlite
sudo rm -f /srv/db/myapp/data.sqlite-wal /srv/db/myapp/data.sqlite-shm
sudo chown -R www-data:www-data /srv/db/myapp
sudo chmod 0640 /srv/db/myapp/data.sqlite
sudo systemctl start apache2
```

### Useful Diagnostic Commands

```bash
sudo systemctl status control-agent dietpi-panel apache2   # or httpd on RHEL/Fedora/Arch
sudo journalctl -u control-agent -n 50 --no-pager
sudo journalctl -u dietpi-panel -n 50 --no-pager
sudo apache2ctl configtest                                # or: sudo apachectl configtest
```

# DietPi Panel

A minimal, self-hosted server control panel inspired by the Cloudflare dashboard, built with **Next.js (App Router, React, TypeScript, Tailwind CSS)** for managing web apps, Apache virtual hosts, D1-style per-app SQLite databases, API keys, TLS certificates, and systemd services on a DietPi / Debian home server.

## Architecture

```
Browser (React Dashboard)
  │
  │ HTTPS (TLS via Let's Encrypt / Apache2)
  ▼
Apache2 Virtual Host (panel.<domain> -> 127.0.0.1:3000)
  │
  ▼
Next.js Server (runs as unprivileged user `panel`)
  ├── Authenticated Server Components & Route Handlers (`requireAdmin()`)
  ├── /srv/db/_panel/panel.sqlite (admin users, scrypt hashes, TOTP secrets)
  │
  │ Local Unix Socket (/run/control-agent.sock, root:panel 0660 + AGENT_SECRET)
  ▼
Control Agent (/opt/control-agent/agent.js, systemd, runs as `root`)
  ├── Fixed action allowlist (no shell strings, strict parameter regexes)
  ├── /var/log/control-agent.log (audit log of every call)
  └── Whitelisted bash scripts (/usr/local/bin/mkdb, listdb, mksite, listsites)
```

### Composable Sites & Databases

- **Databases (`mkdb <name>`)**:
  - Creates `/srv/db/<name>/data.sqlite` in WAL mode owned by `www-data:www-data`.
  - Generates a 256-bit random API key (`openssl rand -hex 32`), prints it **once** to the UI, and stores `SetEnv APP_DB_PATH` + `SetEnv APP_API_KEY` in `/etc/apache2/conf-app-db/<name>.conf` (`0600 root:root`).
  - Symlinks `/var/www/_shared/db.php` into `/var/www/<name>/db.php`.
  - If no site vhost exists yet for `<name>`, creates a minimal `dbonly` Apache vhost (`<name>.<BASE_DOMAIN>`) allowing access solely to `/db.php`.
- **Sites (`mksite <name> <type>`) & App Workspaces (`/sites/<name>`)**:
  - Supports `static`, `php`, `laravel` (`/public` docroot), `react`, `vue`, `astro`, `sveltekit`, `nextjs`, `node`, and `python`.
  - Creating a site automatically provisions its matching SQLite database by default (revealing the API key once and seeding `.env` / `.env.local` for framework apps), and exposes `/db.php` via Apache `Alias`.
  - Built-in jailed file manager (`/var/www/<name>`), `.zip` upload/extract, Git `clone`/`pull`, and preset framework build pipelines (executed as `www-data` without raw shell strings).
  - Optional per-site recursive filesystem watcher triggers the preset build pipeline automatically on SSH/SFTP file changes.
- **Cloudflare Tunnel (`cloudflared`) Auto-Routing**:
  - When `cloudflared` and `/etc/cloudflared/config.yml` exist, creating a site or database automatically runs:
    1. `cloudflared tunnel route dns <tunnel> <hostname>` (using `~/.cloudflared/cert.pem` / `TUNNEL_ORIGIN_CERT`)
    2. Inserts `# dietpi-panel:managed` + `- hostname: <hostname>` / `service: http://localhost:80` before the catch-all rule in `/etc/cloudflared/config.yml`
    3. Validates the config with `cloudflared --config ... tunnel ingress validate` (rolling back on error)
    4. Schedules `systemctl restart cloudflared` ~2 seconds after sending the API response so the dashboard session isn't dropped mid-request.
  - Deleting a site or `dbonly` database removes only `# dietpi-panel:managed` ingress entries from `/etc/cloudflared/config.yml` (existing Cloudflare DNS CNAME records are left untouched since `cloudflared` CLI does not delete DNS records).
  - Customize defaults in `/etc/control-agent/config.env` (`CF_ENABLED`, `CF_TUNNEL_NAME`, `CF_CONFIG`, `CF_SERVICE_URL`, `CF_UNIT`, `TUNNEL_ORIGIN_CERT`).

## Security Model

1. **Privilege Separation**:
   - Next.js runs as `panel` with `ProtectSystem=strict`, `NoNewPrivileges=yes`, and read/write access restricted to `/srv/db/_panel`.
   - `/run/control-agent.sock` is owned by `root:panel` with mode `0660`, isolating PHP/Apache workers (`www-data`) from the control socket.
   - `/etc/apache2/conf-app-db/*.conf` files containing `APP_API_KEY` are `0600 root:root` (Apache reads them as `root` before dropping privileges to `www-data`).
2. **Zero Shell Execution in Agent**:
   - `agent.js` executes every binary via `execFile`/`spawn` with `shell: false`.
   - Every name (`^[a-z0-9-]{1,32}$`), domain, site type, and systemd unit is validated both in Next.js Route Handlers and inside the bash helper scripts (`set -euo pipefail`).
3. **Authentication, Sessions & CSRF**:
   - Passwords hashed with Node `crypto.scryptSync` (`N=16384, r=8, p=1`) and verified with `crypto.timingSafeEqual`.
   - Optional RFC 6238 TOTP 2FA implemented in pure `node:crypto` (no external auth dependencies).
   - Sessions stored in HMAC-SHA256 signed cookies (`httpOnly`, `sameSite=strict`, `secure`), verified in both `middleware.ts` and `requireAdmin()`.
   - In-memory rate limiting on `/api/auth/login` and `/api/auth/totp` (5 failed attempts / 5 minutes per IP).
   - Mutating routes require a matching per-session `x-panel-csrf` header.

## Quick Install (DietPi / Debian)

Prerequisites: Apache2, PHP 8.x (`php-sqlite3` / `pdo_sqlite`), Node.js 20+, SQLite3, Certbot (`python3-certbot-apache`).

```bash
git clone <your-repo-url> dietpi-panel
cd dietpi-panel
sudo ./install.sh
```

After installation:

1. Point DNS records (`panel.<domain>` and `<app>.<domain>`) to your server.
2. Enable TLS (required because session cookies have the `Secure` attribute):
   ```bash
   sudo certbot --apache -d panel.<domain>
   ```
3. Visit `https://panel.<domain>`, log in as `admin`, change your initial password on `/settings`, and enable TOTP 2FA.

### Optional: Restrict Panel Access by IP (`Require ip`)

To restrict `https://panel.<domain>` to your LAN or VPN subnet, edit `/etc/apache2/sites-available/dietpi-panel-le-ssl.conf` (inside `<VirtualHost *:443>`) and uncomment/adjust:

```apache
<Location "/">
    Require ip 192.168.1.0/24 10.0.0.0/8 100.64.0.0/10
</Location>
```

Then validate and reload Apache:

```bash
sudo apache2ctl configtest && sudo systemctl reload apache2
```

## Using the D1-Style SQLite Endpoint (`/db.php`)

Each database created through the panel exposes `https://<name>.<domain>/db.php`:

```bash
curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT)"}'

curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"INSERT INTO items (title) VALUES (?)", "params":["Hello DietPi"]}'

curl -s -X POST "https://notes.mydomain.com/db.php" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_REVEAL_ONCE_API_KEY" \
  -d '{"sql":"SELECT * FROM items"}'
```

Responses:
- Row-returning statements (`SELECT`, `WITH ... SELECT`, `PRAGMA`, `RETURNING`): `{"results":[...]}`
- Mutations / DDL (`INSERT`, `UPDATE`, `DELETE`, `CREATE`): `{"changes":1}`
- Failures: `{"error":"..."}`

## Adding a New Control Agent Action

1. Add a strict parameter validator and `case 'my.action':` handler in `control-agent/agent.js` using `runBin(...)` (`shell: false`).
2. Add the action name to `AgentAction` in `dietpi-panel/src/lib/agent.ts`.
3. Create an authenticated Next.js Route Handler under `dietpi-panel/src/app/api/` that calls `requireAdmin(request)` first, validates parameters with `src/lib/validation.ts`, and forwards to `callControlAgent('my.action', ...)`.
4. Copy updated files with `sudo ./install.sh` (or update `/opt/control-agent/agent.js` and rebuild `/opt/dietpi-panel`), then restart `control-agent` and `dietpi-panel`.

## Backup & Restore Procedure

### Soft-Deleted Resources
- Deleted databases are moved (not purged) to `/srv/db/backups/trash-<name>-<timestamp>/`.
- Deleted sites are archived to `/srv/backups/sites/<name>-<timestamp>/`.

### Consistent SQLite Backups
Never copy a live WAL-mode `.sqlite` file directly with `cp` while writes are occurring; use SQLite's online `.backup` API:

```bash
# Backup an app database safely
sudo sqlite3 /srv/db/myapp/data.sqlite ".backup '/srv/db/backups/myapp-$(date +%F).sqlite'"

# Backup the panel auth database
sudo sqlite3 /srv/db/_panel/panel.sqlite ".backup '/srv/db/backups/panel-$(date +%F).sqlite'"
```

### Restore a Database
```bash
sudo systemctl stop apache2
sudo cp /srv/db/backups/myapp-2026-11-18.sqlite /srv/db/myapp/data.sqlite
sudo rm -f /srv/db/myapp/data.sqlite-wal /srv/db/myapp/data.sqlite-shm
sudo chown -R www-data:www-data /srv/db/myapp
sudo chmod 0640 /srv/db/myapp/data.sqlite
sudo systemctl start apache2
```

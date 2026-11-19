#!/usr/bin/env node
'use strict';

/**
 * DietPi Panel Control Agent
 *
 * Privileged root daemon listening on a local Unix domain socket (/run/control-agent.sock).
 * Accepts JSON-line requests: { secret, action, params }
 * Responds with JSON lines:   { ok, stdout, stderr }
 *
 * Hard security invariants:
 * - Never executes shell strings (shell: false on every execFile/spawn).
 * - Fixed action allowlist with strict parameter validation.
 * - Constant-time secret verification via SHA-256 + timingSafeEqual.
 * - Socket ownership restricted to root:<SOCKET_GROUP> (default: panel), mode 0660.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const SOCKET_PATH = process.env.AGENT_SOCKET || '/run/control-agent.sock';
const LOG_PATH = process.env.AGENT_LOG || '/var/log/control-agent.log';
const SOCKET_GROUP = process.env.SOCKET_GROUP || 'panel';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'localhost';
const CERTBOT_EMAIL = process.env.CERTBOT_EMAIL || '';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CERTBOT_TIMEOUT_MS = 120_000;

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const SITE_TYPE_SET = new Set(['static', 'php', 'nextjs']);
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UNIT_RE = /^[a-zA-Z0-9@_.-]{1,64}$/;
const RESERVED_NAMES = new Set([
  'panel',
  'dietpi-panel',
  'backups',
  'www',
  'localhost',
  'default',
  'shared',
]);

const MUTATING_ACTIONS = new Set([
  'db.create',
  'db.delete',
  'site.create',
  'site.delete',
  'service.restart',
  'cert',
  'tunnel.route',
  'tunnel.unroute',
  'tunnel.restart',
]);

function validateSecretConfigured() {
  if (!AGENT_SECRET || AGENT_SECRET.length < 16) {
    console.error('FATAL: AGENT_SECRET must be set and at least 16 characters long.');
    process.exit(1);
  }
}

function timingSafeEqualSecret(provided) {
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const a = crypto.createHash('sha256').update(AGENT_SECRET, 'utf8').digest();
  const b = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function resolveGroupId(groupName) {
  const groupFile = fs.readFileSync('/etc/group', 'utf8');
  for (const line of groupFile.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts[0] === groupName && parts.length >= 3) {
      const gid = Number.parseInt(parts[2], 10);
      if (Number.isInteger(gid) && gid >= 0) {
        return gid;
      }
    }
  }
  throw new Error(`Required socket group "${groupName}" not found in /etc/group`);
}

function sanitizeParamsForLog(action, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return {};
  }
  const copy = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.toLowerCase().includes('secret') || k.toLowerCase().includes('key') || k.toLowerCase().includes('password')) {
      copy[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 200) {
      copy[k] = `${v.slice(0, 200)}...`;
    } else {
      copy[k] = v;
    }
  }
  if (action === 'unknown') {
    return {};
  }
  return copy;
}

function appendAuditLog(action, params, ok, detail = '') {
  try {
    const logDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o750 });
    }
    if (fs.existsSync(LOG_PATH)) {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size >= MAX_LOG_SIZE_BYTES) {
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
      }
    }
    const ts = new Date().toISOString();
    const safeParams = JSON.stringify(sanitizeParamsForLog(action, params));
    const cleanDetail = String(detail || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 300);
    const status = ok ? 'OK' : 'FAIL';
    const line = `${ts}\t${action}\t${status}\t${safeParams}\t${cleanDetail}\n`;
    fs.appendFileSync(LOG_PATH, line, { mode: 0o640 });
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

function validateName(name, label = 'name') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid ${label}: must match ^[a-z0-9-]{1,32}$`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Reserved ${label} cannot be modified: ${name}`);
  }
  return name;
}

function validateDomain(domain) {
  if (typeof domain !== 'string') {
    throw new Error('Domain must be a string');
  }
  const normalized = domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(normalized)) {
    throw new Error('Invalid domain name');
  }
  return normalized;
}

function getAllowedUnits() {
  const units = new Set(['apache2', 'control-agent']);
  const systemdDir = '/etc/systemd/system';

  if (fs.existsSync(systemdDir)) {
    const entries = fs.readdirSync(systemdDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.service')) continue;
      const stem = entry.name.slice(0, -'.service'.length);
      if (UNIT_RE.test(stem)) {
        units.add(stem);
      }
    }
  }

  if (
    UNIT_RE.test(CF_UNIT) &&
    (fs.existsSync(CF_CONFIG_PATH) || fs.existsSync(`/lib/systemd/system/${CF_UNIT}.service`))
  ) {
    units.add(CF_UNIT);
  }

  const priority = ['apache2', 'control-agent', 'dietpi-panel', CF_UNIT];
  const list = Array.from(units);
  list.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return list;
}

function validateAllowedUnit(rawUnit) {
  if (typeof rawUnit !== 'string' || !rawUnit.trim()) {
    throw new Error('Unit name is required');
  }
  let unit = rawUnit.trim();
  if (unit.endsWith('.service')) {
    unit = unit.slice(0, -'.service'.length);
  }
  if (!UNIT_RE.test(unit)) {
    throw new Error('Invalid unit name format');
  }
  const allowed = getAllowedUnits();
  if (!allowed.includes(unit)) {
    throw new Error(`Unit "${unit}" is not in the allowed service list`);
  }
  return unit;
}

async function runBin(binPath, args, timeout = DEFAULT_TIMEOUT_MS, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      shell: false,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        BASE_DOMAIN,
        ...extraEnv,
      },
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '', code: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' && err.stderr ? err.stderr : err.message,
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function getManagedSiteDomains() {
  const domains = new Set();
  const availDir = '/etc/apache2/sites-available';
  if (!fs.existsSync(availDir)) return domains;
  for (const file of fs.readdirSync(availDir)) {
    if (!file.endsWith('.conf')) continue;
    const content = fs.readFileSync(path.join(availDir, file), 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*ServerName\s+([^\s#]+)/i);
      if (m && m[1]) {
        domains.add(m[1].trim().toLowerCase());
      }
    }
  }
  return domains;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function movePathSafe(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function readVhostServerName(vhostPath) {
  try {
    const content = fs.readFileSync(vhostPath, 'utf8');
    const m = content.match(/^\s*ServerName\s+([^\s#]+)/im);
    return m ? m[1].trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function lastLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel (cloudflared) integration
//
// On site/db create:  cloudflared tunnel route dns <tunnel> <hostname>
//                     + insert "- hostname: <hostname> / service: CF_SERVICE_URL"
//                       before the catch-all rule in /etc/cloudflared/config.yml
//                     + validate, then restart cloudflared in the background.
// On site/db delete:  remove the ingress entry (only entries this panel added,
//                     marked with "# dietpi-panel:managed"). DNS records are kept.
// ---------------------------------------------------------------------------

const CF_ENABLED = (process.env.CF_ENABLED || 'auto').trim().toLowerCase();
const CF_CONFIG_PATH = process.env.CF_CONFIG || '/etc/cloudflared/config.yml';
const CF_SERVICE_URL = (process.env.CF_SERVICE_URL || 'http://localhost:80').trim();
const CF_UNIT = (process.env.CF_UNIT || 'cloudflared').trim().replace(/\.service$/, '');
const CF_TUNNEL_NAME = (process.env.CF_TUNNEL_NAME || '').trim();
const CF_MARKER = '# dietpi-panel:managed';
const CF_RESTART_DELAY_MS = 2000;
const CF_SERVICE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?\/?$/;
const CF_TUNNEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

function stripYamlScalar(raw) {
  let v = String(raw || '').trim();
  v = v.replace(/\s+#.*$/, '').trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

function parseIngress(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const ingressIdx = lines.findIndex((l) => /^ingress:\s*(#.*)?$/.test(l));
  if (ingressIdx === -1) {
    return { eol, lines, ingressIdx: -1, end: -1, itemIndent: null, items: [] };
  }

  // The ingress block ends at the next top-level key (non-list, non-comment line at column 0)
  let end = lines.length;
  for (let i = ingressIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
      end = i;
      break;
    }
  }

  let itemIndent = null;
  const starts = [];
  for (let i = ingressIdx + 1; i < end; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!(trimmed === '-' || trimmed.startsWith('- '))) continue;
    const indent = line.length - line.trimStart().length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) starts.push(i);
  }

  const items = starts.map((start, k) => {
    let last = (k + 1 < starts.length ? starts[k + 1] : end) - 1;
    while (last > start && (!lines[last].trim() || lines[last].trim().startsWith('#'))) {
      last -= 1;
    }
    let hostname = '';
    let service = '';
    for (let i = start; i <= last; i += 1) {
      const m = lines[i].match(/^\s*(?:-\s+)?([A-Za-z]+):\s*(.*)$/);
      if (!m) continue;
      if (m[1] === 'hostname' && !hostname) hostname = stripYamlScalar(m[2]).toLowerCase();
      if (m[1] === 'service' && !service) service = stripYamlScalar(m[2]);
    }
    const managed = start > 0 && lines[start - 1].trim() === CF_MARKER;
    return { start, end: last, hostname, service, managed, markerIdx: managed ? start - 1 : null };
  });

  return { eol, lines, ingressIdx, end, itemIndent, items };
}

function listIngressRules(content) {
  return parseIngress(content).items.map(({ hostname, service, managed }) => ({
    hostname,
    service,
    managed,
  }));
}

function addIngressHostname(content, hostname, service) {
  const host = String(hostname).toLowerCase();
  const p = parseIngress(content);
  if (p.ingressIdx === -1) {
    throw new Error('No top-level "ingress:" block found in the cloudflared config');
  }
  if (p.items.some((it) => it.hostname === host)) {
    return { content, changed: false };
  }

  const pad = ' '.repeat(p.itemIndent === null ? 2 : p.itemIndent);
  const block = [`${pad}${CF_MARKER}`, `${pad}- hostname: ${host}`, `${pad}  service: ${service}`];
  const lines = p.lines.slice();
  const last = p.items[p.items.length - 1];

  if (!last) {
    lines.splice(p.ingressIdx + 1, 0, ...block, `${pad}- service: http_status:404`);
  } else if (!last.hostname) {
    // Insert before the catch-all rule, which cloudflared requires to stay last
    lines.splice(last.markerIdx === null ? last.start : last.markerIdx, 0, ...block);
  } else {
    lines.splice(last.end + 1, 0, ...block);
  }

  return { content: lines.join(p.eol), changed: true };
}

function removeIngressHostname(content, hostname) {
  const host = String(hostname).toLowerCase();
  const p = parseIngress(content);
  if (p.ingressIdx === -1) return { content, changed: false, reason: 'absent' };
  const item = p.items.find((it) => it.hostname === host);
  if (!item) return { content, changed: false, reason: 'absent' };
  if (!item.managed) return { content, changed: false, reason: 'not-managed' };

  const lines = p.lines.slice();
  const from = item.markerIdx === null ? item.start : item.markerIdx;
  lines.splice(from, item.end - from + 1);
  return { content: lines.join(p.eol), changed: true };
}

function findCloudflaredBin() {
  for (const candidate of ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findOriginCert() {
  const candidates = [];
  if (process.env.TUNNEL_ORIGIN_CERT) candidates.push(process.env.TUNNEL_ORIGIN_CERT);
  candidates.push(
    '/root/.cloudflared/cert.pem',
    '/etc/cloudflared/cert.pem',
    '/usr/local/etc/cloudflared/cert.pem'
  );
  try {
    for (const user of fs.readdirSync('/home')) {
      candidates.push(path.join('/home', user, '.cloudflared', 'cert.pem'));
    }
  } catch {
    // no /home
  }
  return (
    candidates.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

function getTunnelSettings() {
  const base = {
    enabled: false,
    reason: '',
    configPath: CF_CONFIG_PATH,
    serviceUrl: CF_SERVICE_URL,
    unit: CF_UNIT,
    tunnel: '',
    originCert: null,
    bin: null,
  };
  if (['0', 'false', 'no', 'off', 'disabled'].includes(CF_ENABLED)) {
    return { ...base, reason: 'Disabled via CF_ENABLED' };
  }
  const bin = findCloudflaredBin();
  if (!bin) return { ...base, reason: 'cloudflared binary not found' };
  if (!fs.existsSync(CF_CONFIG_PATH)) return { ...base, bin, reason: `${CF_CONFIG_PATH} not found` };
  if (!CF_SERVICE_URL_RE.test(CF_SERVICE_URL)) {
    return { ...base, bin, reason: 'CF_SERVICE_URL is invalid (expected e.g. http://localhost:80)' };
  }
  if (!UNIT_RE.test(CF_UNIT)) return { ...base, bin, reason: 'CF_UNIT is invalid' };

  let tunnel = CF_TUNNEL_NAME;
  if (!tunnel) {
    const m = fs.readFileSync(CF_CONFIG_PATH, 'utf8').match(/^tunnel:\s*(.+)$/m);
    if (m) tunnel = stripYamlScalar(m[1]);
  }
  if (!tunnel || !CF_TUNNEL_RE.test(tunnel)) {
    return { ...base, bin, reason: 'Tunnel name/ID not found (set CF_TUNNEL_NAME)' };
  }

  return { ...base, enabled: true, bin, tunnel, originCert: findOriginCert() };
}

let cfLock = Promise.resolve();
function withTunnelLock(fn) {
  const run = cfLock.then(fn, fn);
  cfLock = run.catch(() => {});
  return run;
}

let cfRestartTimer = null;
function scheduleCloudflaredRestart(delayMs = CF_RESTART_DELAY_MS) {
  if (cfRestartTimer) clearTimeout(cfRestartTimer);
  cfRestartTimer = setTimeout(() => {
    cfRestartTimer = null;
    const child = spawn('systemctl', ['restart', CF_UNIT], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', () => {});
    child.unref();
    appendAuditLog('tunnel.restart', { unit: CF_UNIT }, true, 'Restart triggered after ingress change');
  }, delayMs);
}

async function writeValidatedTunnelConfig(settings, newContent) {
  const stat = fs.statSync(CF_CONFIG_PATH);
  const tmpPath = `${CF_CONFIG_PATH}.dietpi-new`;
  fs.rmSync(tmpPath, { force: true });
  fs.writeFileSync(tmpPath, newContent, { mode: stat.mode & 0o777 });
  try {
    const v = await runBin(settings.bin, ['--config', tmpPath, 'tunnel', 'ingress', 'validate']);
    if (!v.ok) {
      throw new Error(`cloudflared ingress validation failed: ${lastLine(v.stderr || v.stdout)}`);
    }
    fs.copyFileSync(CF_CONFIG_PATH, `${CF_CONFIG_PATH}.dietpi-bak`);
    fs.chownSync(tmpPath, stat.uid, stat.gid);
    fs.renameSync(tmpPath, CF_CONFIG_PATH);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

async function tunnelAddHostname(rawDomain) {
  const settings = getTunnelSettings();
  if (!settings.enabled) return { enabled: false, reason: settings.reason };

  const result = {
    enabled: true,
    hostname: '',
    service: settings.serviceUrl,
    tunnel: settings.tunnel,
    dns: 'skipped',
    ingress: 'skipped',
    restartScheduled: false,
    warnings: [],
  };

  try {
    const hostname = validateDomain(rawDomain);
    result.hostname = hostname;

    const env = settings.originCert ? { TUNNEL_ORIGIN_CERT: settings.originCert } : {};
    if (!settings.originCert) {
      result.warnings.push('No cloudflared origin cert.pem found; DNS routing may fail (set TUNNEL_ORIGIN_CERT).');
    }
    const dns = await runBin(
      settings.bin,
      ['tunnel', 'route', 'dns', settings.tunnel, hostname],
      60_000,
      env
    );
    const dnsOut = `${dns.stdout}\n${dns.stderr}`;
    if (dns.ok) {
      result.dns = /already configured/i.test(dnsOut) ? 'exists' : 'routed';
    } else if (/already exists/i.test(dnsOut)) {
      result.dns = 'exists';
      result.warnings.push(
        `A DNS record for ${hostname} already exists and was left unchanged; make sure it is a CNAME to this tunnel.`
      );
    } else {
      result.dns = 'failed';
      result.warnings.push(`DNS route failed: ${lastLine(dnsOut)}`);
    }

    await withTunnelLock(async () => {
      const original = fs.readFileSync(CF_CONFIG_PATH, 'utf8');
      const { content, changed } = addIngressHostname(original, hostname, settings.serviceUrl);
      if (!changed) {
        result.ingress = 'exists';
        return;
      }
      await writeValidatedTunnelConfig(settings, content);
      result.ingress = 'added';
      scheduleCloudflaredRestart();
      result.restartScheduled = true;
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  appendAuditLog(
    'tunnel.route',
    { hostname: result.hostname || String(rawDomain || '') },
    !result.error && result.dns !== 'failed',
    result.error || result.warnings.join(' | ') || `dns=${result.dns} ingress=${result.ingress}`
  );
  return result;
}

async function tunnelRemoveHostname(rawDomain) {
  const settings = getTunnelSettings();
  if (!settings.enabled) return { enabled: false, reason: settings.reason };

  const result = {
    enabled: true,
    hostname: '',
    ingress: 'skipped',
    restartScheduled: false,
    warnings: [],
  };

  try {
    const hostname = validateDomain(rawDomain);
    result.hostname = hostname;
    if (hostname === `panel.${BASE_DOMAIN}`) {
      throw new Error('Refusing to remove the panel hostname from the tunnel');
    }

    await withTunnelLock(async () => {
      const original = fs.readFileSync(CF_CONFIG_PATH, 'utf8');
      const { content, changed, reason } = removeIngressHostname(original, hostname);
      if (!changed) {
        result.ingress = reason || 'absent';
        if (reason === 'not-managed') {
          result.warnings.push(
            `${hostname} was not added by DietPi Panel, so its ingress rule was left in place.`
          );
        }
        return;
      }
      await writeValidatedTunnelConfig(settings, content);
      result.ingress = 'removed';
      scheduleCloudflaredRestart();
      result.restartScheduled = true;
    });
    result.warnings.push(
      `The Cloudflare DNS record for ${hostname} was kept; delete it in the Cloudflare dashboard if no longer needed.`
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  appendAuditLog(
    'tunnel.unroute',
    { hostname: result.hostname || String(rawDomain || '') },
    !result.error,
    result.error || `ingress=${result.ingress}`
  );
  return result;
}

function getTunnelHostnameSet() {
  try {
    if (!fs.existsSync(CF_CONFIG_PATH)) return null;
    const rules = listIngressRules(fs.readFileSync(CF_CONFIG_PATH, 'utf8'));
    return new Set(rules.map((r) => r.hostname).filter(Boolean));
  } catch {
    return null;
  }
}

function attachTunnelResult(stdout, tunnel) {
  try {
    const payload = JSON.parse(stdout);
    payload.tunnel = tunnel;
    return JSON.stringify(payload);
  } catch {
    return stdout;
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function handleAction(action, params = {}, socket = null) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params must be an object');
  }

  switch (action) {
    case 'ping': {
      return { ok: true, stdout: JSON.stringify({ pong: true, time: new Date().toISOString() }), stderr: '' };
    }

    case 'db.create': {
      const name = validateName(params.name, 'database name');
      const res = await runBin('/usr/local/bin/mkdb', [name]);
      if (!res.ok) {
        return { ok: false, stdout: res.stdout, stderr: res.stderr };
      }
      const created = parseJsonSafe(res.stdout.trim());
      if (!created || !created.domain) {
        return { ok: true, stdout: res.stdout.trim(), stderr: res.stderr };
      }
      const tunnel = await tunnelAddHostname(created.domain);
      return { ok: true, stdout: attachTunnelResult(res.stdout.trim(), tunnel), stderr: res.stderr };
    }

    case 'db.list': {
      const res = await runBin('/usr/local/bin/listdb', []);
      return { ok: res.ok, stdout: res.stdout.trim() || '[]', stderr: res.stderr };
    }

    case 'db.delete': {
      const name = validateName(params.name, 'database name');
      const dbDir = `/srv/db/${name}`;
      if (!fs.existsSync(dbDir)) {
        throw new Error(`Database "${name}" does not exist`);
      }

      const backupBase = '/srv/db/backups';
      fs.mkdirSync(backupBase, { recursive: true, mode: 0o750 });
      const trashDir = path.join(backupBase, `trash-${name}-${timestampSlug()}`);
      fs.mkdirSync(trashDir, { recursive: true, mode: 0o750 });

      movePathSafe(dbDir, path.join(trashDir, 'db'));

      const confAppDb = `/etc/apache2/conf-app-db/${name}.conf`;
      if (fs.existsSync(confAppDb)) {
        movePathSafe(confAppDb, path.join(trashDir, 'app-db.conf'));
      }

      const dbSymlink = `/var/www/${name}/db.php`;
      try {
        const lstat = fs.lstatSync(dbSymlink);
        if (lstat.isSymbolicLink() || lstat.isFile()) {
          fs.unlinkSync(dbSymlink);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      const vhostPath = `/etc/apache2/sites-available/${name}.conf`;
      let removedDbonlyVhost = false;
      let dbonlyDomain = '';
      if (fs.existsSync(vhostPath)) {
        const vhostContent = fs.readFileSync(vhostPath, 'utf8');
        if (vhostContent.includes('# dietpi-panel:type=dbonly')) {
          dbonlyDomain = readVhostServerName(vhostPath);
          await runBin('a2dissite', [`${name}.conf`]);
          const leSslPath = `/etc/apache2/sites-available/${name}-le-ssl.conf`;
          if (fs.existsSync(leSslPath)) {
            await runBin('a2dissite', [`${name}-le-ssl.conf`]);
            movePathSafe(leSslPath, path.join(trashDir, `${name}-le-ssl.conf`));
          }
          movePathSafe(vhostPath, path.join(trashDir, `${name}.conf`));
          removedDbonlyVhost = true;

          const docroot = `/var/www/${name}`;
          if (fs.existsSync(docroot) && fs.readdirSync(docroot).length === 0) {
            fs.rmdirSync(docroot);
          }
        }
      }

      const testRes = await runBin('apache2ctl', ['configtest']);
      if (!testRes.ok) {
        return { ok: false, stdout: '', stderr: `Apache configtest failed: ${testRes.stderr}` };
      }
      await runBin('systemctl', ['reload', 'apache2']);

      const dbTunnel = dbonlyDomain ? await tunnelRemoveHostname(dbonlyDomain) : undefined;

      return {
        ok: true,
        stdout: JSON.stringify({ name, archivedTo: trashDir, removedDbonlyVhost, tunnel: dbTunnel }),
        stderr: '',
      };
    }

    case 'site.create': {
      const name = validateName(params.name, 'site name');
      if (typeof params.type !== 'string' || !SITE_TYPE_SET.has(params.type)) {
        throw new Error('Invalid site type: must be static, php, or nextjs');
      }
      const type = params.type;
      const domain = params.domain ? validateDomain(params.domain) : '';
      let portStr = '';
      if (params.port !== undefined && params.port !== null && params.port !== '') {
        const portNum = Number(params.port);
        if (!Number.isInteger(portNum) || portNum < 3001 || portNum > 39999) {
          throw new Error('Invalid port: must be integer between 3001 and 39999');
        }
        if (type !== 'nextjs') {
          throw new Error('Port option is only valid for nextjs sites');
        }
        portStr = String(portNum);
      }

      const res = await runBin('/usr/local/bin/mksite', [name, type, domain, portStr]);
      if (!res.ok) {
        return { ok: false, stdout: res.stdout.trim(), stderr: res.stderr };
      }
      const created = parseJsonSafe(res.stdout.trim());
      if (!created || !created.domain) {
        return { ok: true, stdout: res.stdout.trim(), stderr: res.stderr };
      }
      const tunnel = await tunnelAddHostname(created.domain);
      return { ok: true, stdout: attachTunnelResult(res.stdout.trim(), tunnel), stderr: res.stderr };
    }

    case 'site.list': {
      const res = await runBin('/usr/local/bin/listsites', []);
      const raw = res.stdout.trim() || '[]';
      const hostSet = res.ok ? getTunnelHostnameSet() : null;
      const sites = hostSet ? parseJsonSafe(raw) : null;
      if (!Array.isArray(sites)) {
        return { ok: res.ok, stdout: raw, stderr: res.stderr };
      }
      for (const site of sites) {
        site.tunnel = hostSet.has(String(site.serverName || '').toLowerCase());
      }
      return { ok: true, stdout: JSON.stringify(sites), stderr: res.stderr };
    }

    case 'site.delete': {
      const name = validateName(params.name, 'site name');
      const vhostPath = `/etc/apache2/sites-available/${name}.conf`;
      const leSslPath = `/etc/apache2/sites-available/${name}-le-ssl.conf`;
      const docroot = `/var/www/${name}`;
      const appService = `/etc/systemd/system/app-${name}.service`;

      if (!fs.existsSync(vhostPath) && !fs.existsSync(docroot)) {
        throw new Error(`Site "${name}" does not exist`);
      }

      const siteDomain = readVhostServerName(vhostPath);
      const archiveBase = '/srv/backups/sites';
      fs.mkdirSync(archiveBase, { recursive: true, mode: 0o750 });
      const archiveDir = path.join(archiveBase, `${name}-${timestampSlug()}`);
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o750 });

      await runBin('a2dissite', [`${name}.conf`]);
      if (fs.existsSync(leSslPath)) {
        await runBin('a2dissite', [`${name}-le-ssl.conf`]);
        movePathSafe(leSslPath, path.join(archiveDir, `${name}-le-ssl.conf`));
      }
      if (fs.existsSync(vhostPath)) {
        movePathSafe(vhostPath, path.join(archiveDir, `${name}.conf`));
      }
      if (fs.existsSync(docroot)) {
        movePathSafe(docroot, path.join(archiveDir, 'www'));
      }
      if (fs.existsSync(appService)) {
        await runBin('systemctl', ['stop', `app-${name}.service`]);
        await runBin('systemctl', ['disable', `app-${name}.service`]);
        movePathSafe(appService, path.join(archiveDir, `app-${name}.service`));
        await runBin('systemctl', ['daemon-reload']);
      }

      const testRes = await runBin('apache2ctl', ['configtest']);
      if (!testRes.ok) {
        return { ok: false, stdout: '', stderr: `Apache configtest failed: ${testRes.stderr}` };
      }
      await runBin('systemctl', ['reload', 'apache2']);

      const siteTunnel = siteDomain ? await tunnelRemoveHostname(siteDomain) : undefined;

      return {
        ok: true,
        stdout: JSON.stringify({ name, archivedTo: archiveDir, tunnel: siteTunnel }),
        stderr: '',
      };
    }

    case 'service.list': {
      const units = getAllowedUnits();
      const results = await Promise.all(
        units.map(async (unit) => {
          const res = await runBin('systemctl', [
            'show',
            unit,
            '--property=ActiveState,SubState,LoadState,Description',
            '--no-pager',
          ]);
          const props = {};
          for (const line of res.stdout.split('\n')) {
            const idx = line.indexOf('=');
            if (idx > 0) {
              props[line.slice(0, idx)] = line.slice(idx + 1).trim();
            }
          }
          return {
            unit,
            activeState: props.ActiveState || 'unknown',
            subState: props.SubState || 'unknown',
            loadState: props.LoadState || 'unknown',
            description: props.Description || unit,
            active: props.ActiveState === 'active',
          };
        })
      );
      return { ok: true, stdout: JSON.stringify(results), stderr: '' };
    }

    case 'service.status': {
      const unit = validateAllowedUnit(params.unit);
      const res = await runBin('systemctl', ['status', unit, '--no-pager', '-l']);
      // systemctl status exits with 3 when inactive; treat 0 or 3 as valid status output
      const ok = res.code === 0 || res.code === 3;
      return { ok, stdout: res.stdout, stderr: ok ? '' : res.stderr };
    }

    case 'service.restart': {
      const unit = validateAllowedUnit(params.unit);
      if (unit === 'control-agent' || unit === 'dietpi-panel' || unit === CF_UNIT) {
        // Respond first so the caller receives confirmation before systemd restarts the process
        // (restarting cloudflared also drops the tunnel carrying the panel's own HTTP response)
        const payload = {
          ok: true,
          stdout: JSON.stringify({ unit, restarted: true, scheduled: true }),
          stderr: '',
        };
        if (socket && !socket.destroyed) {
          socket.write(`${JSON.stringify(payload)}\n`);
        }
        setTimeout(() => {
          const child = spawn('systemctl', ['restart', unit], {
            detached: true,
            stdio: 'ignore',
            shell: false,
          });
          child.unref();
        }, unit === CF_UNIT ? CF_RESTART_DELAY_MS : 200);
        return { ...payload, _alreadyWritten: true };
      }

      const res = await runBin('systemctl', ['restart', unit]);
      return {
        ok: res.ok,
        stdout: res.ok ? JSON.stringify({ unit, restarted: true, scheduled: false }) : res.stdout,
        stderr: res.stderr,
      };
    }

    case 'logs': {
      const unit = validateAllowedUnit(params.unit);
      let lines = 100;
      if (params.lines !== undefined && params.lines !== null) {
        const parsed = Number.parseInt(String(params.lines), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          throw new Error('lines must be an integer between 1 and 1000');
        }
        lines = parsed;
      }
      const res = await runBin('journalctl', ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
      return { ok: res.ok, stdout: res.stdout, stderr: res.stderr };
    }

    case 'cert': {
      const domain = validateDomain(params.domain);
      const dryRun = Boolean(params.dryRun);
      const managedDomains = getManagedSiteDomains();
      if (!managedDomains.has(domain)) {
        throw new Error(`Domain "${domain}" does not match any configured Apache virtual host`);
      }

      const args = ['--apache', '-d', domain, '--non-interactive', '--agree-tos'];
      if (CERTBOT_EMAIL) {
        args.push('--email', CERTBOT_EMAIL);
      } else {
        const acctDir = '/etc/letsencrypt/accounts';
        const hasAccount = fs.existsSync(acctDir) && fs.readdirSync(acctDir).length > 0;
        if (!hasAccount) {
          args.push('--register-unsafely-without-email');
        }
      }
      if (dryRun) {
        args.push('--dry-run');
      }

      const res = await runBin('certbot', args, CERTBOT_TIMEOUT_MS);
      return { ok: res.ok, stdout: res.stdout, stderr: res.stderr };
    }

    case 'tunnel.route': {
      const domain = validateDomain(params.domain);
      const managedDomains = getManagedSiteDomains();
      if (!managedDomains.has(domain)) {
        throw new Error(`Domain "${domain}" does not match any configured Apache virtual host`);
      }
      const tunnel = await tunnelAddHostname(domain);
      if (!tunnel.enabled) {
        throw new Error(`Cloudflare tunnel integration unavailable: ${tunnel.reason}`);
      }
      if (tunnel.error) {
        return { ok: false, stdout: JSON.stringify(tunnel), stderr: tunnel.error };
      }
      return { ok: true, stdout: JSON.stringify(tunnel), stderr: '' };
    }

    case 'stats': {
      const [dbRes, siteRes, apacheRes, duRes, dfRes] = await Promise.all([
        runBin('/usr/local/bin/listdb', []),
        runBin('/usr/local/bin/listsites', []),
        runBin('systemctl', ['is-active', 'apache2']),
        runBin('du', ['-sb', '/srv/db']),
        runBin('df', ['-B1', '--output=size,used,avail,pcent', '/srv/db']),
      ]);

      let databases = [];
      let sites = [];
      try {
        databases = JSON.parse(dbRes.stdout || '[]');
      } catch {
        databases = [];
      }
      try {
        sites = JSON.parse(siteRes.stdout || '[]');
      } catch {
        sites = [];
      }

      let dbDirBytes = 0;
      const duMatch = (duRes.stdout || '').trim().match(/^(\d+)/);
      if (duMatch) {
        dbDirBytes = Number.parseInt(duMatch[1], 10);
      }

      let fsTotalBytes = 0;
      let fsUsedBytes = 0;
      let fsAvailBytes = 0;
      let fsUsedPercent = 0;
      const dfLines = (dfRes.stdout || '').trim().split('\n');
      if (dfLines.length >= 2) {
        const cols = dfLines[dfLines.length - 1].trim().split(/\s+/);
        if (cols.length >= 4) {
          fsTotalBytes = Number.parseInt(cols[0], 10) || 0;
          fsUsedBytes = Number.parseInt(cols[1], 10) || 0;
          fsAvailBytes = Number.parseInt(cols[2], 10) || 0;
          fsUsedPercent = Number.parseInt(cols[3].replace('%', ''), 10) || 0;
        }
      }

      const activeSitesCount = sites.filter((s) => !s.isPanel).length;
      const stats = {
        dbCount: databases.length,
        siteCount: activeSitesCount,
        totalVhosts: sites.length,
        apacheActive: apacheRes.stdout.trim() === 'active',
        disk: {
          dbDirBytes,
          fsTotalBytes,
          fsUsedBytes,
          fsAvailBytes,
          fsUsedPercent,
        },
      };

      return { ok: true, stdout: JSON.stringify(stats), stderr: '' };
    }

    case 'activity.list': {
      let limit = 50;
      if (params.lines !== undefined && params.lines !== null) {
        const parsed = Number.parseInt(String(params.lines), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
          throw new Error('lines must be an integer between 1 and 200');
        }
        limit = parsed;
      }
      const includeReads = Boolean(params.includeReads);

      const readTailLines = (filePath) => {
        if (!fs.existsSync(filePath)) return [];
        const stat = fs.statSync(filePath);
        const readSize = Math.min(stat.size, 256 * 1024);
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
          let text = buf.toString('utf8');
          if (stat.size > readSize) {
            const firstNl = text.indexOf('\n');
            if (firstNl !== -1) text = text.slice(firstNl + 1);
          }
          return text.split('\n').filter(Boolean);
        } finally {
          fs.closeSync(fd);
        }
      };

      const rawLines = [
        ...readTailLines(`${LOG_PATH}.1`),
        ...readTailLines(LOG_PATH),
      ];

      const entries = [];
      for (let i = rawLines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
        const line = rawLines[i];
        const parts = line.split('\t');
        if (parts.length < 4) continue;
        const [timestamp, entryAction, status, rawParams, ...rest] = parts;
        const ok = status === 'OK';
        if (!includeReads && ok && !MUTATING_ACTIONS.has(entryAction)) {
          continue;
        }
        let parsedParams = {};
        try {
          parsedParams = JSON.parse(rawParams || '{}');
        } catch {
          parsedParams = {};
        }
        entries.push({
          timestamp,
          action: entryAction,
          ok,
          params: parsedParams,
          detail: rest.join('\t'),
        });
      }

      return { ok: true, stdout: JSON.stringify(entries), stderr: '' };
    }

    default:
      throw new Error(`Unsupported action: ${String(action)}`);
  }
}

function createServer() {
  validateSecretConfigured();

  const socketDir = path.dirname(SOCKET_PATH);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
  }
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const groupId = resolveGroupId(SOCKET_GROUP);

  const server = net.createServer((socket) => {
    let buffer = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(CERTBOT_TIMEOUT_MS + 5000);

    const writeResponse = (resp) => {
      if (!socket.destroyed) {
        socket.end(`${JSON.stringify({ ok: Boolean(resp.ok), stdout: resp.stdout || '', stderr: resp.stderr || '' })}\n`);
      }
    };

    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        appendAuditLog('invalid', {}, false, 'Request exceeds max size');
        writeResponse({ ok: false, stdout: '', stderr: 'Request payload too large' });
        return;
      }

      const nlIndex = buffer.indexOf('\n');
      if (nlIndex === -1) return;

      handled = true;
      const line = buffer.slice(0, nlIndex).trim();

      let req;
      try {
        req = JSON.parse(line);
      } catch {
        appendAuditLog('parse', {}, false, 'Invalid JSON line');
        writeResponse({ ok: false, stdout: '', stderr: 'Invalid JSON request' });
        return;
      }

      if (!req || typeof req !== 'object' || !timingSafeEqualSecret(req.secret)) {
        appendAuditLog('auth', { action: typeof req?.action === 'string' ? req.action : 'unknown' }, false, 'Authentication failed');
        writeResponse({ ok: false, stdout: '', stderr: 'Unauthorized' });
        return;
      }

      const action = typeof req.action === 'string' ? req.action.trim() : '';
      const params = req.params && typeof req.params === 'object' ? req.params : {};

      try {
        const result = await handleAction(action, params, socket);
        appendAuditLog(action || 'unknown', params, result.ok, result.ok ? '' : result.stderr);
        if (!result._alreadyWritten) {
          writeResponse(result);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        appendAuditLog(action || 'unknown', params, false, errMsg);
        writeResponse({ ok: false, stdout: '', stderr: errMsg });
      }
    });

    socket.on('timeout', () => {
      if (!handled) {
        handled = true;
        writeResponse({ ok: false, stdout: '', stderr: 'Request timed out' });
      }
    });

    socket.on('error', () => {
      // Client disconnected prematurely
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chownSync(SOCKET_PATH, 0, groupId);
    fs.chmodSync(SOCKET_PATH, 0o660);
    console.log(`control-agent listening on ${SOCKET_PATH} (group=${SOCKET_GROUP}, mode=0660)`);
  });

  const shutdown = () => {
    server.close(() => {
      try {
        if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
      } catch {
        // ignore
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

if (require.main === module) {
  createServer();
}

module.exports = {
  validateName,
  validateDomain,
  timingSafeEqualSecret,
  sanitizeParamsForLog,
  parseIngress,
  listIngressRules,
  addIngressHostname,
  removeIngressHostname,
  NAME_RE,
  DOMAIN_RE,
  UNIT_RE,
};

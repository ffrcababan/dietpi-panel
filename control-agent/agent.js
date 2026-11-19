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

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CERTBOT_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;
const BUILD_LOG_DIR = '/var/log/dietpi-panel-builds';
const WATCHERS_FILE = '/etc/control-agent/watchers.json';

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const SITE_TYPE_SET = new Set([
  'static',
  'php',
  'laravel',
  'react',
  'vue',
  'astro',
  'sveltekit',
  'nextjs',
  'node',
  'python',
]);
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
  'files.write',
  'files.upload',
  'files.uploadFinish',
  'files.mkdir',
  'files.rename',
  'files.chmod',
  'files.delete',
  'site.git',
  'site.build',
  'site.fixPermissions',
  'site.watch',
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
    const lower = k.toLowerCase();
    if (
      lower.includes('secret') ||
      lower.includes('key') ||
      lower.includes('password') ||
      k === 'content' ||
      k === 'contentBase64'
    ) {
      copy[k] = typeof v === 'string' ? `[REDACTED:${v.length}b]` : '[REDACTED]';
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

// ---------------------------------------------------------------------------
// Jailed Site File Manager, Git Deploy, Framework Builds & Recursive Watcher
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TMP_DIR = '/tmp/dp-uploads';
const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
const GIT_URL_RE = /^(?:https:\/\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=%-]+|git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+)$/;
const GIT_BRANCH_RE = /^[a-zA-Z0-9._/-]{1,64}$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;

function pruneStaleUploads() {
  if (!fs.existsSync(UPLOAD_TMP_DIR)) return;
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const entry of fs.readdirSync(UPLOAD_TMP_DIR)) {
    const p = path.join(UPLOAD_TMP_DIR, entry);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

function isEnvSecretFile(relPosix) {
  const base = path.posix.basename(relPosix);
  if (
    base === '.env.example' ||
    base === '.env.sample' ||
    base === '.env.template' ||
    base === '.env.dist'
  ) {
    return false;
  }
  return base === '.env' || base.startsWith('.env.') || /\.(pem|key)$/i.test(base);
}

function isGroupWritableRelDir(relPosix, siteType, hasDatabaseSqlite = false) {
  if (!relPosix) return false;
  const matchPrefix = (prefix) => relPosix === prefix || relPosix.startsWith(`${prefix}/`);
  if (siteType === 'laravel') {
    if (
      matchPrefix('storage') ||
      matchPrefix('bootstrap/cache') ||
      matchPrefix('public/build') ||
      matchPrefix('public/storage')
    ) {
      return true;
    }
    if (hasDatabaseSqlite && matchPrefix('database')) {
      return true;
    }
    return false;
  }
  if (siteType === 'php') {
    return (
      matchPrefix('storage') ||
      matchPrefix('bootstrap/cache') ||
      matchPrefix('uploads') ||
      matchPrefix('cache') ||
      matchPrefix('logs') ||
      matchPrefix('tmp') ||
      matchPrefix('var') ||
      matchPrefix('data')
    );
  }
  if (siteType === 'nextjs' || siteType === 'node') {
    return (
      matchPrefix('uploads') ||
      matchPrefix('logs') ||
      matchPrefix('data') ||
      matchPrefix('tmp')
    );
  }
  if (siteType === 'python') {
    return (
      matchPrefix('instance') ||
      matchPrefix('uploads') ||
      matchPrefix('media') ||
      matchPrefix('logs') ||
      matchPrefix('tmp') ||
      matchPrefix('data') ||
      matchPrefix('var')
    );
  }
  return false;
}

function hasShebangOrElf(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return true; // #!
    if (
      bytesRead >= 4 &&
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    ) {
      return true; // \x7fELF
    }
  } catch {
    // ignore unreadable
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  return false;
}

const NON_EXEC_ASSET_RE =
  /\.(php|html?|css|scss|sass|less|json|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|md|txt|ya?ml|sql|lock|map|ts|tsx|jsx|d\.ts|log|sqlite|db)$/i;

function isExecutableSiteFile(absPath, relPosix, currentMode = 0) {
  const base = path.posix.basename(relPosix);
  if (isEnvSecretFile(relPosix)) return false;

  if (
    relPosix === 'artisan' ||
    relPosix === 'gradlew' ||
    relPosix === 'mvnw' ||
    relPosix.endsWith('.sh') ||
    relPosix.startsWith('node_modules/.bin/') ||
    relPosix.startsWith('vendor/bin/') ||
    relPosix.startsWith('.venv/bin/') ||
    relPosix.startsWith('venv/bin/') ||
    relPosix.startsWith('bin/')
  ) {
    return true;
  }

  if (NON_EXEC_ASSET_RE.test(base)) {
    return false;
  }

  if (
    relPosix.includes('/bin/') ||
    relPosix.startsWith('scripts/') ||
    relPosix.startsWith('node_modules/') ||
    relPosix.startsWith('.venv/') ||
    relPosix.startsWith('venv/')
  ) {
    if (relPosix.includes('/bin/') || relPosix.startsWith('scripts/')) {
      return (currentMode & 0o111) !== 0 || hasShebangOrElf(absPath);
    }
    if ((currentMode & 0o111) !== 0 && !base.endsWith('.js') && !base.endsWith('.mjs') && !base.endsWith('.cjs') && !base.endsWith('.py')) {
      return hasShebangOrElf(absPath);
    }
  }

  return false;
}

function getEffectiveSiteType(siteRoot, siteType) {
  if (siteType === 'laravel' || fs.existsSync(path.join(siteRoot, 'artisan'))) {
    return 'laravel';
  }
  return siteType || '';
}

function ensureModeIfNeeded(targetPath, lst, desiredMode) {
  if ((lst.mode & 0o777) !== desiredMode) {
    fs.chmodSync(targetPath, desiredMode);
    return true;
  }
  return false;
}

function ensureOwnerIfNeeded(targetPath, lst, uid, gid) {
  if (lst.uid !== uid || lst.gid !== gid) {
    chownPathNoFollow(targetPath, uid, gid);
    return true;
  }
  return false;
}

function ensureLaravelWritableDirs(siteRoot, uid, gid) {
  const dirs = [
    ['storage', 0o775],
    ['storage/app', 0o775],
    ['storage/app/public', 0o775],
    ['storage/framework', 0o775],
    ['storage/framework/cache', 0o775],
    ['storage/framework/cache/data', 0o775],
    ['storage/framework/sessions', 0o775],
    ['storage/framework/testing', 0o775],
    ['storage/framework/views', 0o775],
    ['storage/logs', 0o775],
    ['bootstrap', 0o755],
    ['bootstrap/cache', 0o775],
  ];
  for (const [rel, mode] of dirs) {
    const abs = path.join(siteRoot, rel);
    try {
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(abs, { recursive: true, mode });
      }
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink() || !lst.isDirectory()) continue;
      ensureOwnerIfNeeded(abs, lst, uid, gid);
      ensureModeIfNeeded(abs, lst, mode);
    } catch {
      // ignore
    }
  }
}

function applySitePermissions(siteRoot, siteType = '', opts = {}) {
  const { ensureFrameworkDirs = true } = opts;
  const { uid, gid } = getWwwDataIds();
  const effectiveType = getEffectiveSiteType(siteRoot, siteType);

  let dirsUpdated = 0;
  let filesUpdated = 0;
  let executablesFixed = 0;

  try {
    const rootLst = fs.lstatSync(siteRoot);
    if (!rootLst.isDirectory()) {
      return { type: effectiveType || 'static', dirsUpdated, filesUpdated, executablesFixed, writableDirs: [] };
    }
    const ownerChanged = ensureOwnerIfNeeded(siteRoot, rootLst, uid, gid);
    const modeChanged = ensureModeIfNeeded(siteRoot, rootLst, 0o755);
    if (ownerChanged || modeChanged) dirsUpdated += 1;
  } catch {
    return { type: effectiveType || 'static', dirsUpdated, filesUpdated, executablesFixed, writableDirs: [] };
  }

  if (ensureFrameworkDirs && effectiveType === 'laravel') {
    ensureLaravelWritableDirs(siteRoot, uid, gid);
  }

  let hasDatabaseSqlite = false;
  if (effectiveType === 'laravel') {
    try {
      const dbSub = path.join(siteRoot, 'database');
      if (fs.existsSync(dbSub) && fs.lstatSync(dbSub).isDirectory()) {
        hasDatabaseSqlite = fs
          .readdirSync(dbSub)
          .some((f) => f.endsWith('.sqlite') || f.endsWith('.sqlite3') || f.endsWith('.db'));
      }
    } catch {
      // ignore
    }
  }

  const writableDirsFound = new Set();
  const stack = [{ absDir: siteRoot, relDir: '' }];

  while (stack.length > 0) {
    const { absDir, relDir } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const relPosix = relDir ? `${relDir}/${entry.name}` : entry.name;
      let lst;
      try {
        lst = fs.lstatSync(abs);
      } catch {
        continue;
      }

      if (lst.isSymbolicLink()) {
        // Never follow symlinks on chmod (protects shared /db.php target!)
        ensureOwnerIfNeeded(abs, lst, uid, gid);
        continue;
      }

      if (lst.isDirectory()) {
        const isWritable = isGroupWritableRelDir(relPosix, effectiveType, hasDatabaseSqlite);
        if (
          isWritable &&
          (relPosix === 'storage' ||
            relPosix === 'bootstrap/cache' ||
            relPosix === 'uploads' ||
            relPosix === 'logs' ||
            relPosix === 'cache' ||
            relPosix === 'instance' ||
            relPosix === 'database')
        ) {
          writableDirsFound.add(relPosix);
        }
        const desiredDirMode = isWritable ? 0o775 : 0o755;
        const ownerChanged = ensureOwnerIfNeeded(abs, lst, uid, gid);
        const modeChanged = ensureModeIfNeeded(abs, lst, desiredDirMode);
        if (ownerChanged || modeChanged) dirsUpdated += 1;
        stack.push({ absDir: abs, relDir: relPosix });
      } else if (lst.isFile()) {
        let desiredFileMode;
        if (isEnvSecretFile(relPosix)) {
          desiredFileMode = 0o640;
        } else if (isExecutableSiteFile(abs, relPosix, lst.mode)) {
          desiredFileMode = 0o755;
        } else if (isGroupWritableRelDir(relDir, effectiveType, hasDatabaseSqlite)) {
          desiredFileMode = 0o664;
        } else {
          desiredFileMode = 0o644;
        }
        const ownerChanged = ensureOwnerIfNeeded(abs, lst, uid, gid);
        const modeChanged = ensureModeIfNeeded(abs, lst, desiredFileMode);
        if (ownerChanged || modeChanged) filesUpdated += 1;
        if (modeChanged && desiredFileMode === 0o755) executablesFixed += 1;
      }
    }
  }

  return {
    type: effectiveType || siteType || 'static',
    dirsUpdated,
    filesUpdated,
    executablesFixed,
    writableDirs: Array.from(writableDirsFound).sort(),
  };
}

function chownDirChain(siteRoot, leafDir, uid, gid, siteType = '') {
  const effectiveType = getEffectiveSiteType(siteRoot, siteType);
  let cursor = leafDir;
  while (cursor !== siteRoot && cursor.startsWith(`${siteRoot}${path.sep}`)) {
    const relCursor = path.relative(siteRoot, cursor).split(path.sep).join('/');
    const desiredDirMode = isGroupWritableRelDir(relCursor, effectiveType, false) ? 0o775 : 0o755;
    try {
      const lst = fs.lstatSync(cursor);
      if (!lst.isSymbolicLink()) {
        ensureOwnerIfNeeded(cursor, lst, uid, gid);
        ensureModeIfNeeded(cursor, lst, desiredDirMode);
      }
    } catch {
      chownPathNoFollow(cursor, uid, gid);
    }
    cursor = path.dirname(cursor);
  }
  try {
    const rootLst = fs.lstatSync(siteRoot);
    if (!rootLst.isSymbolicLink()) {
      ensureOwnerIfNeeded(siteRoot, rootLst, uid, gid);
      ensureModeIfNeeded(siteRoot, rootLst, 0o755);
    }
  } catch {
    // ignore
  }
}

async function installUploadedFile({
  name,
  dir,
  filename,
  buffer,
  sourcePath,
  extractZip,
  triggerBuild,
}) {
  if (!SAFE_FILENAME_RE.test(filename) || filename === '.' || filename === '..') {
    throw new Error('Invalid filename: use 1-128 characters [a-zA-Z0-9._-]');
  }

  const cleanDir = String(dir || '').replace(/\/+$/g, '');
  const relTarget = cleanDir ? `${cleanDir}/${filename}` : filename;
  const { siteRoot, targetPath, relPath } = resolveJailedPath(name, relTarget, {
    allowRoot: false,
    allowMissingLeaf: true,
    protectDbPhp: true,
  });

  const siteType = getSiteTypeFromVhost(name);
  const parentDir = path.dirname(targetPath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });

  const { uid, gid } = getWwwDataIds();
  chownDirChain(siteRoot, parentDir, uid, gid, siteType);

  const totalBytes = sourcePath ? fs.statSync(sourcePath).size : buffer.length;
  let extractedFiles = 0;

  if (extractZip && filename.toLowerCase().endsWith('.zip')) {
    const unzipBin = findExecutable(['/usr/bin/unzip', '/usr/local/bin/unzip']);
    if (!unzipBin) {
      throw new Error('unzip is not installed on the server (apt install unzip)');
    }
    const stageDir = fs.mkdtempSync('/tmp/dp-unzip-');
    const zipTmp = sourcePath || path.join(stageDir, 'upload.zip');
    const extractDir = path.join(stageDir, 'out');
    fs.mkdirSync(extractDir, { mode: 0o755 });
    try {
      if (!sourcePath) {
        fs.writeFileSync(zipTmp, buffer, { mode: 0o600 });
      }
      await execFileAsync(unzipBin, ['-q', '-o', zipTmp, '-d', extractDir], {
        shell: false,
        timeout: 120_000,
      });

      const copySafe = (srcDir, destDir) => {
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
          const s = path.join(srcDir, entry.name);
          const d = path.join(destDir, entry.name);
          const lst = fs.lstatSync(s);
          if (lst.isSymbolicLink()) {
            throw new Error(`Zip archive contains forbidden symlink: ${entry.name}`);
          }
          if (destDir === siteRoot && entry.name === 'db.php') {
            continue;
          }
          const relDest = path.relative(siteRoot, d).split(path.sep).join('/');
          const effectiveType = getEffectiveSiteType(siteRoot, siteType);
          if (lst.isDirectory()) {
            const dMode = isGroupWritableRelDir(relDest, effectiveType, false) ? 0o775 : 0o755;
            fs.mkdirSync(d, { recursive: true, mode: dMode });
            fs.chmodSync(d, dMode);
            chownPathNoFollow(d, uid, gid);
            copySafe(s, d);
          } else {
            fs.copyFileSync(s, d);
            const relParent = path.posix.dirname(relDest) === '.' ? '' : path.posix.dirname(relDest);
            let fMode;
            if (isEnvSecretFile(relDest)) {
              fMode = 0o640;
            } else if (isExecutableSiteFile(d, relDest, lst.mode)) {
              fMode = 0o755;
            } else if (isGroupWritableRelDir(relParent, effectiveType, false)) {
              fMode = 0o664;
            } else {
              fMode = 0o644;
            }
            fs.chmodSync(d, fMode);
            chownPathNoFollow(d, uid, gid);
            extractedFiles += 1;
          }
        }
      };
      copySafe(extractDir, parentDir);
      applySitePermissions(siteRoot, siteType, { ensureFrameworkDirs: true });
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  } else {
    const effectiveType = getEffectiveSiteType(siteRoot, siteType);
    const relParent = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    if (sourcePath) {
      fs.copyFileSync(sourcePath, targetPath);
    } else {
      fs.writeFileSync(targetPath, buffer);
    }
    let fMode;
    if (isEnvSecretFile(relPath)) {
      fMode = 0o640;
    } else if (isExecutableSiteFile(targetPath, relPath, 0)) {
      fMode = 0o755;
    } else if (isGroupWritableRelDir(relParent, effectiveType, false)) {
      fMode = 0o664;
    } else {
      fMode = 0o644;
    }
    fs.chmodSync(targetPath, fMode);
    chownPathNoFollow(targetPath, uid, gid);
  }

  const build = triggerBuild ? await runSiteBuild(name, 'upload') : null;
  return {
    path: relPath,
    bytes: totalBytes,
    extractedFiles,
    build,
  };
}

const WATCH_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '.venv',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  '.astro',
  'storage',
  '__pycache__',
  '.cache',
]);

let cachedWwwDataIds = null;
function getWwwDataIds() {
  if (cachedWwwDataIds) return cachedWwwDataIds;
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === 'www-data' && parts.length >= 4) {
        const uid = Number.parseInt(parts[2], 10);
        const gid = Number.parseInt(parts[3], 10);
        if (Number.isInteger(uid) && Number.isInteger(gid)) {
          cachedWwwDataIds = { uid, gid };
          return cachedWwwDataIds;
        }
      }
    }
  } catch {
    // non-Linux local test fallback
  }
  return { uid: 33, gid: 33 };
}

function chownPathNoFollow(targetPath, uid, gid) {
  try {
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      if (typeof fs.lchownSync === 'function') fs.lchownSync(targetPath, uid, gid);
    } else {
      fs.chownSync(targetPath, uid, gid);
    }
  } catch {
    // ignore missing or unsupported
  }
}

function chownRecursiveSafe(targetPath, uid, gid) {
  chownPathNoFollow(targetPath, uid, gid);
  try {
    const st = fs.lstatSync(targetPath);
    if (!st.isDirectory()) return;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      const child = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        chownRecursiveSafe(child, uid, gid);
      } else {
        chownPathNoFollow(child, uid, gid);
      }
    }
  } catch {
    // ignore
  }
}

function resolveJailedPath(name, rawRelPath = '', opts = {}) {
  const { allowRoot = false, allowMissingLeaf = false, protectDbPhp = true } = opts;
  const siteName = validateName(name, 'site name');
  const baseDir = `/var/www/${siteName}`;
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Site root directory does not exist: ${baseDir}`);
  }
  const siteRoot = fs.realpathSync(baseDir);

  if (rawRelPath !== undefined && rawRelPath !== null && typeof rawRelPath !== 'string') {
    throw new Error('Path must be a string');
  }
  const normalizedInput = String(rawRelPath || '').replace(/\\/g, '/').trim();
  if (normalizedInput.includes('\0')) {
    throw new Error('Invalid null byte in path');
  }
  if (normalizedInput.startsWith('/')) {
    throw new Error('Absolute paths are not permitted');
  }

  const parts = normalizedInput.split('/').filter((s) => s !== '' && s !== '.');
  for (const part of parts) {
    if (part === '..') {
      throw new Error('Path traversal ("..") is not permitted');
    }
  }

  const relPath = parts.join('/');
  if (!relPath) {
    if (!allowRoot) {
      throw new Error('A relative file or folder path is required');
    }
    return { siteRoot, targetPath: siteRoot, relPath: '' };
  }

  if (protectDbPhp && relPath === 'db.php') {
    throw new Error('The shared db.php endpoint symlink is managed by DietPi Panel');
  }

  const candidate = path.resolve(siteRoot, relPath);
  const ensureInside = (resolved) => {
    if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}${path.sep}`)) {
      throw new Error('Resolved path escapes site directory');
    }
  };

  if (fs.existsSync(candidate)) {
    const resolved = fs.realpathSync(candidate);
    ensureInside(resolved);
    return { siteRoot, targetPath: resolved, relPath };
  }

  if (!allowMissingLeaf) {
    throw new Error(`Path not found: ${relPath}`);
  }

  // Walk upward to the deepest existing parent to verify no symlink escapes the jail
  let cursor = path.dirname(candidate);
  while (!fs.existsSync(cursor)) {
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  const resolvedAncestor = fs.realpathSync(cursor);
  ensureInside(resolvedAncestor);

  const tail = path.relative(cursor, candidate);
  const finalTarget = path.join(resolvedAncestor, tail);
  ensureInside(finalTarget);
  return { siteRoot, targetPath: finalTarget, relPath };
}

function getSiteTypeFromVhost(name) {
  const vhostPath = `/etc/apache2/sites-available/${name}.conf`;
  if (!fs.existsSync(vhostPath)) return 'custom';
  const content = fs.readFileSync(vhostPath, 'utf8');
  const m = content.match(/^#\s*dietpi-panel:type=([a-z0-9-]+)/m);
  return m ? m[1].trim() : 'custom';
}

function seedFrameworkEnv(name, type, domain, port, dbInfo) {
  if (!dbInfo || !dbInfo.dbPath || !dbInfo.apiKey) return null;
  const siteRoot = `/var/www/${name}`;
  if (!fs.existsSync(siteRoot)) return null;

  const envFileName = type === 'nextjs' ? '.env.local' : '.env';
  const envPath = path.join(siteRoot, envFileName);
  if (fs.existsSync(envPath)) return null;

  if (type === 'static' || type === 'php') {
    return null;
  }

  const lines = [];
  if (type === 'laravel') {
    lines.push(
      `APP_NAME=${name}`,
      'APP_ENV=production',
      `APP_URL=https://${domain}`,
      'DB_CONNECTION=sqlite',
      `DB_DATABASE=${dbInfo.dbPath}`,
      `PANEL_DB_ENDPOINT=https://${domain}/db.php`,
      `PANEL_DB_API_KEY=${dbInfo.apiKey}`
    );
  } else {
    if (port) lines.push(`PORT=${port}`);
    lines.push(
      `DB_PATH=${dbInfo.dbPath}`,
      `DB_ENDPOINT=https://${domain}/db.php`,
      `DB_API_KEY=${dbInfo.apiKey}`
    );
  }

  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o640 });
  const { uid, gid } = getWwwDataIds();
  chownPathNoFollow(envPath, uid, gid);
  return envFileName;
}

function findExecutable(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function runAsWwwData(bin, args, cwd, timeout = BUILD_TIMEOUT_MS, extraEnv = {}) {
  const { uid, gid } = getWwwDataIds();
  const wwwHome = '/tmp/dp-www-home';
  const cacheDirs = [
    wwwHome,
    path.join(wwwHome, '.cache'),
    path.join(wwwHome, '.config'),
    path.join(wwwHome, '.local'),
    path.join(wwwHome, '.local', 'share'),
    '/tmp/npm-cache-www-data',
    '/tmp/composer-www-data',
    '/tmp/pip-cache-www-data',
  ];
  for (const dir of cacheDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    }
    try {
      const lst = fs.lstatSync(dir);
      if (lst.isDirectory()) {
        if (lst.uid !== uid || lst.gid !== gid) {
          chownRecursiveSafe(dir, uid, gid);
        }
        if ((lst.mode & 0o777) !== 0o750) {
          fs.chmodSync(dir, 0o750);
        }
      }
    } catch {
      chownPathNoFollow(dir, uid, gid);
    }
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      uid,
      gid,
      shell: false,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: wwwHome,
        XDG_CACHE_HOME: path.join(wwwHome, '.cache'),
        XDG_CONFIG_HOME: path.join(wwwHome, '.config'),
        XDG_DATA_HOME: path.join(wwwHome, '.local', 'share'),
        NPM_CONFIG_CACHE: '/tmp/npm-cache-www-data',
        COMPOSER_HOME: '/tmp/composer-www-data',
        PIP_CACHE_DIR: '/tmp/pip-cache-www-data',
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
    });
    return {
      cmd: `${path.basename(bin)} ${args.join(' ')}`.trim(),
      ok: true,
      stdout: (stdout || '').slice(-8000),
      stderr: (stderr || '').slice(-4000),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      cmd: `${path.basename(bin)} ${args.join(' ')}`.trim(),
      ok: false,
      stdout: (typeof err.stdout === 'string' ? err.stdout : '').slice(-8000),
      stderr: (typeof err.stderr === 'string' && err.stderr ? err.stderr : err.message).slice(-4000),
      durationMs: Date.now() - start,
    };
  }
}

function readPackageScripts(siteRoot) {
  const pkgPath = path.join(siteRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function readBuildStatus(name) {
  const statusFile = path.join(BUILD_LOG_DIR, `${name}.json`);
  if (!fs.existsSync(statusFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeBuildStatus(name, record) {
  if (!fs.existsSync(BUILD_LOG_DIR)) {
    fs.mkdirSync(BUILD_LOG_DIR, { recursive: true, mode: 0o750 });
  }
  const statusFile = path.join(BUILD_LOG_DIR, `${name}.json`);
  fs.writeFileSync(statusFile, JSON.stringify(record, null, 2), { mode: 0o640 });
}

const activeBuilds = new Set();
const pendingBuildTriggers = new Map();
const lastBuildCompleteAt = new Map();

async function executeSiteBuildOnce(name, trigger = 'manual') {
  const siteRoot = fs.realpathSync(`/var/www/${name}`);
  const type = getSiteTypeFromVhost(name);
  const startedAt = new Date().toISOString();
  const steps = [];
  let allOk = true;

  const npmBin = findExecutable(['/usr/bin/npm', '/usr/local/bin/npm']) || 'npm';
  const phpBin = findExecutable(['/usr/bin/php', '/usr/local/bin/php']) || 'php';
  const composerBin = findExecutable(['/usr/local/bin/composer', '/usr/bin/composer']);
  const pythonBin = findExecutable(['/usr/bin/python3', '/usr/local/bin/python3']) || 'python3';

  const runStep = async (bin, args, extraEnv = {}) => {
    const step = await runAsWwwData(bin, args, siteRoot, BUILD_TIMEOUT_MS, extraEnv);
    steps.push(step);
    if (!step.ok) allOk = false;
    return step.ok;
  };

  const tPermPre = Date.now();
  const permPre = applySitePermissions(siteRoot, type, { ensureFrameworkDirs: true });
  steps.push({
    cmd: `permissions (${permPre.type})`,
    ok: true,
    stdout: `Verified www-data ownership & Linux permissions (dirs updated: ${permPre.dirsUpdated}, files updated: ${permPre.filesUpdated}, executables +x: ${permPre.executablesFixed}${permPre.writableDirs.length ? `, writable 0775: ${permPre.writableDirs.join(', ')}` : ''}).`,
    stderr: '',
    durationMs: Date.now() - tPermPre,
  });

  if (type === 'static' || type === 'dbonly') {
    steps.push({
      cmd: 'noop (static)',
      ok: true,
      stdout: 'Static site requires no build step.',
      stderr: '',
      durationMs: 0,
    });
  } else if (type === 'php') {
    if (fs.existsSync(path.join(siteRoot, 'index.php'))) {
      await runStep(phpBin, ['-l', 'index.php']);
    } else {
      steps.push({
        cmd: 'php -l',
        ok: true,
        stdout: 'No index.php found; skipping syntax check.',
        stderr: '',
        durationMs: 0,
      });
    }
  } else if (type === 'laravel') {
    if (fs.existsSync(path.join(siteRoot, 'composer.json'))) {
      if (!composerBin) {
        steps.push({
          cmd: 'composer install',
          ok: false,
          stdout: '',
          stderr: 'composer is not installed on the server (apt install composer)',
          durationMs: 0,
        });
        allOk = false;
      } else {
        await runStep(composerBin, [
          'install',
          '--no-dev',
          '--optimize-autoloader',
          '--no-interaction',
        ]);
      }
    }
    const scripts = readPackageScripts(siteRoot);
    if (allOk && scripts && typeof scripts.build === 'string') {
      const installCmd = fs.existsSync(path.join(siteRoot, 'package-lock.json')) ? 'ci' : 'install';
      if (await runStep(npmBin, [installCmd])) {
        await runStep(npmBin, ['run', 'build']);
      }
    }
    if (allOk && fs.existsSync(path.join(siteRoot, 'artisan'))) {
      if (await runStep(phpBin, ['artisan', 'migrate', '--force'])) {
        await runStep(phpBin, ['artisan', 'config:cache']);
        await runStep(phpBin, ['artisan', 'route:cache']);
        await runStep(phpBin, ['artisan', 'view:cache']);
      }
    }
  } else if (type === 'react' || type === 'vue' || type === 'astro' || type === 'sveltekit') {
    const scripts = readPackageScripts(siteRoot);
    if (!scripts) {
      steps.push({
        cmd: 'npm run build',
        ok: true,
        stdout: 'No package.json present yet; skipping build.',
        stderr: '',
        durationMs: 0,
      });
    } else {
      const installCmd = fs.existsSync(path.join(siteRoot, 'package-lock.json')) ? 'ci' : 'install';
      if (await runStep(npmBin, [installCmd])) {
        if (typeof scripts.build === 'string') {
          await runStep(npmBin, ['run', 'build']);
        }
      }
    }
  } else if (type === 'nextjs' || type === 'node') {
    const scripts = readPackageScripts(siteRoot);
    if (!scripts) {
      steps.push({
        cmd: 'npm install',
        ok: true,
        stdout: 'No package.json present yet; skipping build.',
        stderr: '',
        durationMs: 0,
      });
    } else {
      const installCmd = fs.existsSync(path.join(siteRoot, 'package-lock.json')) ? 'ci' : 'install';
      if (await runStep(npmBin, [installCmd], { NODE_ENV: 'development' })) {
        if (typeof scripts.build === 'string') {
          await runStep(npmBin, ['run', 'build'], { NODE_ENV: 'production' });
        }
      }
    }
    if (allOk && fs.existsSync(`/etc/systemd/system/app-${name}.service`) && scripts) {
      const t0 = Date.now();
      await runBin('systemctl', ['enable', `app-${name}.service`]);
      const rst = await runBin('systemctl', ['restart', `app-${name}.service`]);
      steps.push({
        cmd: `systemctl restart app-${name}.service`,
        ok: rst.ok,
        stdout: rst.ok ? `Restarted app-${name}.service` : rst.stdout,
        stderr: rst.stderr,
        durationMs: Date.now() - t0,
      });
      if (!rst.ok) allOk = false;
    }
  } else if (type === 'python') {
    const venvDir = path.join(siteRoot, '.venv');
    if (!fs.existsSync(venvDir)) {
      await runStep(pythonBin, ['-m', 'venv', '.venv']);
    }
    const pipBin = path.join(venvDir, 'bin', 'pip');
    if (allOk && fs.existsSync(path.join(siteRoot, 'requirements.txt')) && fs.existsSync(pipBin)) {
      await runStep(pipBin, ['install', '-r', 'requirements.txt']);
    }
    if (
      allOk &&
      fs.existsSync(`/etc/systemd/system/app-${name}.service`) &&
      fs.existsSync(path.join(siteRoot, 'app.py'))
    ) {
      const t0 = Date.now();
      await runBin('systemctl', ['enable', `app-${name}.service`]);
      const rst = await runBin('systemctl', ['restart', `app-${name}.service`]);
      steps.push({
        cmd: `systemctl restart app-${name}.service`,
        ok: rst.ok,
        stdout: rst.ok ? `Restarted app-${name}.service` : rst.stdout,
        stderr: rst.stderr,
        durationMs: Date.now() - t0,
      });
      if (!rst.ok) allOk = false;
    }
  }

  // Re-normalize permissions on generated build artifacts (vendor/, node_modules/, .next/, storage/, bootstrap/cache/)
  applySitePermissions(siteRoot, type, { ensureFrameworkDirs: true });

  const record = {
    name,
    type,
    trigger,
    ok: allOk,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
  };
  writeBuildStatus(name, record);
  lastBuildCompleteAt.set(name, Date.now());
  return record;
}

async function runSiteBuild(name, trigger = 'manual') {
  validateName(name, 'site name');
  if (!fs.existsSync(`/var/www/${name}`)) {
    throw new Error(`Site "${name}" directory does not exist`);
  }
  if (activeBuilds.has(name)) {
    pendingBuildTriggers.set(name, trigger);
    return { queued: true, name, trigger };
  }

  activeBuilds.add(name);
  let lastRecord;
  try {
    lastRecord = await executeSiteBuildOnce(name, trigger);
    while (pendingBuildTriggers.has(name)) {
      const nextTrigger = pendingBuildTriggers.get(name);
      pendingBuildTriggers.delete(name);
      lastRecord = await executeSiteBuildOnce(name, nextTrigger);
    }
  } finally {
    activeBuilds.delete(name);
  }
  appendAuditLog('site.build', { name, trigger, type: lastRecord?.type }, Boolean(lastRecord?.ok));
  return lastRecord;
}

// Per-directory inotify watcher (works on all Node 20+ Linux versions without recursive: true)
const activeWatchers = new Map(); // name -> { watchers: Map<dir, FSWatcher>, timer: NodeJS.Timeout | null }

function loadPersistedWatchers() {
  try {
    if (!fs.existsSync(WATCHERS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(WATCHERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((n) => NAME_RE.test(String(n))) : [];
  } catch {
    return [];
  }
}

function savePersistedWatchers(names) {
  const dir = path.dirname(WATCHERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
  fs.writeFileSync(WATCHERS_FILE, JSON.stringify(Array.from(new Set(names)).sort()), { mode: 0o640 });
}

function isSiteWatcherEnabled(name) {
  return activeWatchers.has(name);
}

function disableSiteWatcher(name, persist = true) {
  const state = activeWatchers.get(name);
  if (state) {
    if (state.timer) clearTimeout(state.timer);
    for (const w of state.watchers.values()) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    activeWatchers.delete(name);
  }
  if (persist) {
    const remaining = loadPersistedWatchers().filter((n) => n !== name);
    savePersistedWatchers(remaining);
  }
}

function enableSiteWatcher(name, persist = true) {
  validateName(name, 'site name');
  const rootDir = `/var/www/${name}`;
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Site root does not exist: ${rootDir}`);
  }
  const siteRoot = fs.realpathSync(rootDir);
  if (activeWatchers.has(name)) {
    return { enabled: true, watchedDirs: activeWatchers.get(name).watchers.size };
  }

  const state = { watchers: new Map(), timer: null };

  const triggerDebounced = () => {
    const lastDone = lastBuildCompleteAt.get(name) || 0;
    if (Date.now() - lastDone < 3000 || activeBuilds.has(name)) {
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      runSiteBuild(name, 'watcher').catch((err) => {
        appendAuditLog('site.build', { name, trigger: 'watcher' }, false, err.message);
      });
    }, 1500);
  };

  const attachDir = (dirPath) => {
    if (state.watchers.has(dirPath) || state.watchers.size >= 300) return;
    const base = path.basename(dirPath);
    if (dirPath !== siteRoot && WATCH_IGNORED_DIRS.has(base)) return;

    try {
      const w = fs.watch(dirPath, (eventType, filename) => {
        if (filename) {
          const fname = String(filename);
          if (WATCH_IGNORED_DIRS.has(fname) || /\.(log|tmp|swp)$/i.test(fname)) {
            return;
          }
          const full = path.join(dirPath, fname);
          try {
            if (fs.existsSync(full) && fs.lstatSync(full).isDirectory()) {
              attachDir(full);
            }
          } catch {
            // ignore transient race
          }
        }
        triggerDebounced();
      });
      w.on('error', () => {
        state.watchers.delete(dirPath);
      });
      state.watchers.set(dirPath, w);

      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || WATCH_IGNORED_DIRS.has(entry.name)) continue;
        attachDir(path.join(dirPath, entry.name));
      }
    } catch {
      // ignore unreadable subdir
    }
  };

  attachDir(siteRoot);
  activeWatchers.set(name, state);

  if (persist) {
    const existing = loadPersistedWatchers();
    if (!existing.includes(name)) {
      existing.push(name);
      savePersistedWatchers(existing);
    }
  }
  return { enabled: true, watchedDirs: state.watchers.size };
}

function startPersistedWatchers() {
  for (const name of loadPersistedWatchers()) {
    if (fs.existsSync(`/var/www/${name}`)) {
      try {
        enableSiteWatcher(name, false);
      } catch {
        // skip invalid
      }
    }
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
        throw new Error(
          'Invalid site type: must be static, php, laravel, react, vue, astro, sveltekit, nextjs, node, or python'
        );
      }
      const type = params.type;
      const domain = params.domain ? validateDomain(params.domain) : '';
      const createDb = params.createDb !== false;
      const enableWatch = Boolean(params.watch);
      let portStr = '';
      if (params.port !== undefined && params.port !== null && params.port !== '') {
        const portNum = Number(params.port);
        if (!Number.isInteger(portNum) || portNum < 3001 || portNum > 39999) {
          throw new Error('Invalid port: must be integer between 3001 and 39999');
        }
        if (type !== 'nextjs' && type !== 'node' && type !== 'python') {
          throw new Error('Port option is only valid for nextjs, node, or python sites');
        }
        portStr = String(portNum);
      }

      const res = await runBin('/usr/local/bin/mksite', [name, type, domain, portStr]);
      if (!res.ok) {
        return { ok: false, stdout: res.stdout.trim(), stderr: res.stderr };
      }
      const created = parseJsonSafe(res.stdout.trim()) || { name, type, domain };

      let database = null;
      let existingDb = false;
      let envFile = null;
      let dbError = null;
      const dbPath = `/srv/db/${name}/data.sqlite`;

      if (fs.existsSync(dbPath)) {
        existingDb = true;
      } else if (createDb) {
        const dbRes = await runBin('/usr/local/bin/mkdb', [name]);
        if (dbRes.ok) {
          database = parseJsonSafe(dbRes.stdout.trim());
          if (database) {
            try {
              envFile = seedFrameworkEnv(
                name,
                type,
                created.domain || database.domain,
                created.port,
                database
              );
            } catch (envErr) {
              dbError = `Created DB, failed to seed env file: ${envErr.message}`;
            }
          }
        } else {
          dbError = dbRes.stderr || 'Automatic database creation failed';
        }
      }

      if (enableWatch) {
        try {
          enableSiteWatcher(name, true);
        } catch {
          // ignore watcher setup failure
        }
      }

      const tunnel = created.domain ? await tunnelAddHostname(created.domain) : undefined;
      return {
        ok: true,
        stdout: JSON.stringify({
          ...created,
          database,
          existingDb,
          envFile,
          dbError,
          watch: isSiteWatcherEnabled(name),
          tunnel,
        }),
        stderr: res.stderr,
      };
    }

    case 'site.list': {
      const res = await runBin('/usr/local/bin/listsites', []);
      const raw = res.stdout.trim() || '[]';
      if (!res.ok) {
        return { ok: false, stdout: raw, stderr: res.stderr };
      }
      const sites = parseJsonSafe(raw);
      if (!Array.isArray(sites)) {
        return { ok: true, stdout: raw, stderr: res.stderr };
      }
      const hostSet = getTunnelHostnameSet();
      for (const site of sites) {
        if (hostSet) {
          site.tunnel = hostSet.has(String(site.serverName || '').toLowerCase());
        }
        site.watch = isSiteWatcherEnabled(String(site.name || ''));
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

      disableSiteWatcher(name, true);

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

    case 'files.list': {
      const { siteRoot, targetPath, relPath } = resolveJailedPath(
        params.name,
        params.path || '',
        { allowRoot: true, protectDbPhp: false }
      );
      const st = fs.lstatSync(targetPath);
      if (!st.isDirectory()) {
        throw new Error('Target path is not a directory');
      }
      const entries = [];
      for (const dirent of fs.readdirSync(targetPath, { withFileTypes: true })) {
        const full = path.join(targetPath, dirent.name);
        let lst;
        try {
          lst = fs.lstatSync(full);
        } catch {
          continue;
        }
        let type = 'file';
        if (lst.isDirectory()) type = 'dir';
        else if (lst.isSymbolicLink()) type = 'symlink';
        entries.push({
          name: dirent.name,
          path: relPath ? `${relPath}/${dirent.name}` : dirent.name,
          type,
          size: lst.size,
          mode: `0${(lst.mode & 0o777).toString(8).padStart(3, '0')}`,
          modified: lst.mtime.toISOString(),
        });
      }
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      return {
        ok: true,
        stdout: JSON.stringify({
          siteRoot,
          path: relPath,
          entries,
        }),
        stderr: '',
      };
    }

    case 'files.read': {
      const { targetPath, relPath } = resolveJailedPath(params.name, params.path, {
        allowRoot: false,
        protectDbPhp: false,
      });
      const st = fs.lstatSync(targetPath);
      if (st.isDirectory()) {
        throw new Error('Cannot read a directory as a file');
      }
      if (st.size > MAX_READ_BYTES) {
        throw new Error(`File exceeds ${MAX_READ_BYTES} byte read limit (${st.size} bytes)`);
      }
      const buf = fs.readFileSync(targetPath);
      const binary = buf.includes(0);
      return {
        ok: true,
        stdout: JSON.stringify({
          path: relPath,
          size: st.size,
          binary,
          content: binary ? '' : buf.toString('utf8'),
        }),
        stderr: '',
      };
    }

    case 'files.write': {
      if (typeof params.content !== 'string') {
        throw new Error('File content must be a string');
      }
      const contentBytes = Buffer.byteLength(params.content, 'utf8');
      if (contentBytes > MAX_WRITE_BYTES) {
        throw new Error(`File content exceeds ${MAX_WRITE_BYTES} byte limit`);
      }
      const name = validateName(params.name, 'site name');
      const { siteRoot, targetPath, relPath } = resolveJailedPath(name, params.path, {
        allowRoot: false,
        allowMissingLeaf: true,
        protectDbPhp: true,
      });
      const siteType = getSiteTypeFromVhost(name);
      const effectiveType = getEffectiveSiteType(siteRoot, siteType);
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
      }
      fs.writeFileSync(targetPath, params.content);
      const { uid, gid } = getWwwDataIds();
      chownDirChain(siteRoot, parentDir, uid, gid, effectiveType);
      const relParent = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
      let fileMode;
      if (isEnvSecretFile(relPath)) {
        fileMode = 0o640;
      } else if (isExecutableSiteFile(targetPath, relPath, 0)) {
        fileMode = 0o755;
      } else if (isGroupWritableRelDir(relParent, effectiveType, false)) {
        fileMode = 0o664;
      } else {
        fileMode = 0o644;
      }
      fs.chmodSync(targetPath, fileMode);
      chownPathNoFollow(targetPath, uid, gid);

      const triggerBuild = params.triggerBuild !== false;
      const build = triggerBuild ? await runSiteBuild(name, 'file-edit') : null;
      return {
        ok: true,
        stdout: JSON.stringify({ path: relPath, size: contentBytes, build }),
        stderr: '',
      };
    }

    case 'files.upload': {
      const name = validateName(params.name, 'site name');
      const filename = typeof params.filename === 'string' ? params.filename.trim() : '';
      if (typeof params.contentBase64 !== 'string') {
        throw new Error('contentBase64 must be a string');
      }
      const buf = Buffer.from(params.contentBase64, 'base64');
      if (buf.length > MAX_UPLOAD_BYTES) {
        throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} byte limit`);
      }

      const result = await installUploadedFile({
        name,
        dir: params.dir,
        filename,
        buffer: buf,
        sourcePath: null,
        extractZip: Boolean(params.extractZip),
        triggerBuild: params.triggerBuild !== false,
      });
      return { ok: true, stdout: JSON.stringify(result), stderr: '' };
    }

    case 'files.uploadStart': {
      validateName(params.name, 'site name');
      pruneStaleUploads();
      fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
      const uploadId = crypto.randomBytes(16).toString('hex');
      const partPath = path.join(UPLOAD_TMP_DIR, `${uploadId}.part`);
      fs.writeFileSync(partPath, Buffer.alloc(0), { mode: 0o600 });
      return { ok: true, stdout: JSON.stringify({ uploadId }), stderr: '' };
    }

    case 'files.uploadChunk': {
      const uploadId = typeof params.uploadId === 'string' ? params.uploadId.trim() : '';
      if (!UPLOAD_ID_RE.test(uploadId)) {
        throw new Error('Invalid uploadId');
      }
      const partPath = path.join(UPLOAD_TMP_DIR, `${uploadId}.part`);
      if (!fs.existsSync(partPath)) {
        throw new Error('Upload session expired or not found');
      }
      if (typeof params.contentBase64 !== 'string') {
        throw new Error('contentBase64 must be a string');
      }
      const chunkBuf = Buffer.from(params.contentBase64, 'base64');
      if (chunkBuf.length > 4 * 1024 * 1024) {
        throw new Error('Upload chunk exceeds 4 MB limit');
      }
      const currentSize = fs.statSync(partPath).size;
      if (currentSize + chunkBuf.length > MAX_TOTAL_UPLOAD_BYTES) {
        fs.rmSync(partPath, { force: true });
        throw new Error(`Total upload exceeds ${MAX_TOTAL_UPLOAD_BYTES} byte (100 MB) limit`);
      }
      fs.appendFileSync(partPath, chunkBuf);
      return {
        ok: true,
        stdout: JSON.stringify({ bytesWritten: currentSize + chunkBuf.length }),
        stderr: '',
      };
    }

    case 'files.uploadFinish': {
      const name = validateName(params.name, 'site name');
      const uploadId = typeof params.uploadId === 'string' ? params.uploadId.trim() : '';
      if (!UPLOAD_ID_RE.test(uploadId)) {
        throw new Error('Invalid uploadId');
      }
      const partPath = path.join(UPLOAD_TMP_DIR, `${uploadId}.part`);
      if (!fs.existsSync(partPath)) {
        throw new Error('Upload session expired or not found');
      }
      const filename = typeof params.filename === 'string' ? params.filename.trim() : '';
      try {
        const result = await installUploadedFile({
          name,
          dir: params.dir,
          filename,
          buffer: null,
          sourcePath: partPath,
          extractZip: Boolean(params.extractZip),
          triggerBuild: params.triggerBuild !== false,
        });
        return { ok: true, stdout: JSON.stringify(result), stderr: '' };
      } finally {
        fs.rmSync(partPath, { force: true });
      }
    }

    case 'files.mkdir': {
      const name = validateName(params.name, 'site name');
      const { siteRoot, targetPath, relPath } = resolveJailedPath(name, params.path, {
        allowRoot: false,
        allowMissingLeaf: true,
        protectDbPhp: true,
      });
      const siteType = getSiteTypeFromVhost(name);
      fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
      const { uid, gid } = getWwwDataIds();
      chownDirChain(siteRoot, targetPath, uid, gid, siteType);
      return { ok: true, stdout: JSON.stringify({ path: relPath }), stderr: '' };
    }

    case 'files.rename': {
      const name = validateName(params.name, 'site name');
      const fromRes = resolveJailedPath(name, params.fromPath, {
        allowRoot: false,
        protectDbPhp: true,
      });
      const toRes = resolveJailedPath(name, params.toPath, {
        allowRoot: false,
        allowMissingLeaf: true,
        protectDbPhp: true,
      });
      if (fs.existsSync(toRes.targetPath)) {
        throw new Error(`Destination already exists: ${toRes.relPath}`);
      }
      fs.mkdirSync(path.dirname(toRes.targetPath), { recursive: true, mode: 0o755 });
      movePathSafe(fromRes.targetPath, toRes.targetPath);
      const { uid, gid } = getWwwDataIds();
      const siteType = getSiteTypeFromVhost(name);
      chownDirChain(toRes.siteRoot, path.dirname(toRes.targetPath), uid, gid, siteType);
      chownRecursiveSafe(toRes.targetPath, uid, gid);
      return {
        ok: true,
        stdout: JSON.stringify({ fromPath: fromRes.relPath, toPath: toRes.relPath }),
        stderr: '',
      };
    }

    case 'files.chmod': {
      const name = validateName(params.name, 'site name');
      const siteType = getSiteTypeFromVhost(name);
      const { siteRoot, targetPath, relPath } = resolveJailedPath(name, params.path, {
        allowRoot: false,
        protectDbPhp: true,
      });
      const modeStr = typeof params.mode === 'string' ? params.mode.trim() : '';
      if (!/^0?[0-7]{3}$/.test(modeStr)) {
        throw new Error('Mode must be a 3-digit or 4-digit octal permission (e.g. 0644, 0755, 0775)');
      }
      const parsedMode = Number.parseInt(modeStr, 8);
      if ((parsedMode & 0o002) !== 0) {
        throw new Error('World-writable modes (e.g. 777) are blocked for security; use 775 with www-data ownership');
      }
      const rootLst = fs.lstatSync(targetPath);
      if (rootLst.isSymbolicLink()) {
        throw new Error('Cannot chmod a symbolic link');
      }
      const { uid, gid } = getWwwDataIds();
      const recursive = Boolean(params.recursive);
      let updatedCount = 0;

      const applySingle = (absPath, lst) => {
        if (lst.isSymbolicLink()) return;
        const rel = path.relative(siteRoot, absPath).split(path.sep).join('/');
        if (rel === 'db.php') return;
        ensureOwnerIfNeeded(absPath, lst, uid, gid);
        fs.chmodSync(absPath, parsedMode);
        updatedCount += 1;
      };

      if (recursive && rootLst.isDirectory()) {
        const stack = [targetPath];
        while (stack.length > 0) {
          const cur = stack.pop();
          let st;
          try {
            st = fs.lstatSync(cur);
          } catch {
            continue;
          }
          if (st.isSymbolicLink()) continue;
          applySingle(cur, st);
          if (st.isDirectory()) {
            for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
              stack.push(path.join(cur, entry.name));
            }
          }
        }
      } else {
        applySingle(targetPath, rootLst);
      }

      return {
        ok: true,
        stdout: JSON.stringify({
          path: relPath,
          mode: `0${parsedMode.toString(8).padStart(3, '0')}`,
          recursive: recursive && rootLst.isDirectory(),
          updatedCount,
          type: siteType,
        }),
        stderr: '',
      };
    }

    case 'files.delete': {
      const name = validateName(params.name, 'site name');
      const { targetPath, relPath } = resolveJailedPath(name, params.path, {
        allowRoot: false,
        protectDbPhp: true,
      });
      fs.rmSync(targetPath, { recursive: true, force: true });
      return { ok: true, stdout: JSON.stringify({ deleted: relPath }), stderr: '' };
    }

    case 'site.git': {
      const name = validateName(params.name, 'site name');
      const siteRoot = fs.realpathSync(`/var/www/${name}`);
      const gitBin = findExecutable(['/usr/bin/git', '/usr/local/bin/git']);
      if (!gitBin) {
        throw new Error('git is not installed on the server (apt install git)');
      }

      const gitAction = typeof params.action === 'string' ? params.action : 'status';
      const hasGit = fs.existsSync(path.join(siteRoot, '.git'));

      if (gitAction === 'status') {
        if (!hasGit) {
          return {
            ok: true,
            stdout: JSON.stringify({ initialized: false, remote: '', branch: '', status: '' }),
            stderr: '',
          };
        }
        const [remRes, brRes, stRes] = await Promise.all([
          runAsWwwData(gitBin, ['-C', siteRoot, 'remote', 'get-url', 'origin'], siteRoot, 15_000),
          runAsWwwData(gitBin, ['-C', siteRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], siteRoot, 15_000),
          runAsWwwData(gitBin, ['-C', siteRoot, 'status', '--short'], siteRoot, 15_000),
        ]);
        return {
          ok: true,
          stdout: JSON.stringify({
            initialized: true,
            remote: remRes.ok ? remRes.stdout.trim() : '',
            branch: brRes.ok ? brRes.stdout.trim() : '',
            status: stRes.stdout.trim(),
          }),
          stderr: '',
        };
      }

      const branch =
        typeof params.branch === 'string' && params.branch.trim()
          ? params.branch.trim()
          : '';
      if (branch && (branch.startsWith('-') || !GIT_BRANCH_RE.test(branch))) {
        throw new Error('Invalid git branch name');
      }
      const triggerBuild = params.triggerBuild !== false;

      if (gitAction === 'clone') {
        const repoUrl = typeof params.repoUrl === 'string' ? params.repoUrl.trim() : '';
        if (!repoUrl || repoUrl.startsWith('-') || !GIT_URL_RE.test(repoUrl)) {
          throw new Error('Invalid repository URL (use https://... or git@...)');
        }
        if (hasGit) {
          throw new Error('Repository already initialized; use git pull instead');
        }

        const stageDir = fs.mkdtempSync('/tmp/dp-clone-');
        const { uid, gid } = getWwwDataIds();
        chownPathNoFollow(stageDir, uid, gid);
        try {
          const cloneArgs = ['clone', '--depth', '1'];
          if (branch) cloneArgs.push('--branch', branch);
          cloneArgs.push('--', repoUrl, path.join(stageDir, 'repo'));

          const cloneStep = await runAsWwwData(gitBin, cloneArgs, stageDir, BUILD_TIMEOUT_MS);
          if (!cloneStep.ok) {
            return { ok: false, stdout: '', stderr: cloneStep.stderr || 'git clone failed' };
          }

          // Merge cloned repository into siteRoot while preserving .env* and db.php symlink
          const repoDir = path.join(stageDir, 'repo');
          for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
            if (entry.name === 'db.php' || entry.name === '.env' || entry.name === '.env.local') {
              continue;
            }
            const src = path.join(repoDir, entry.name);
            const dest = path.join(siteRoot, entry.name);
            if (fs.existsSync(dest)) {
              fs.rmSync(dest, { recursive: true, force: true });
            }
            movePathSafe(src, dest);
          }
          applySitePermissions(siteRoot, getSiteTypeFromVhost(name), {
            ensureFrameworkDirs: true,
          });
        } finally {
          fs.rmSync(stageDir, { recursive: true, force: true });
        }

        const build = triggerBuild ? await runSiteBuild(name, 'git-clone') : null;
        return {
          ok: true,
          stdout: JSON.stringify({ cloned: true, repoUrl, branch: branch || 'default', build }),
          stderr: '',
        };
      }

      if (gitAction === 'pull') {
        if (!hasGit) {
          throw new Error('No git repository found in this site; clone a repository first');
        }
        const pullArgs = ['-C', siteRoot, 'pull', '--ff-only'];
        if (branch) pullArgs.push('origin', branch);
        const pullStep = await runAsWwwData(gitBin, pullArgs, siteRoot, BUILD_TIMEOUT_MS);
        if (!pullStep.ok) {
          return { ok: false, stdout: pullStep.stdout, stderr: pullStep.stderr || 'git pull failed' };
        }
        applySitePermissions(siteRoot, getSiteTypeFromVhost(name), {
          ensureFrameworkDirs: true,
        });
        const build = triggerBuild ? await runSiteBuild(name, 'git-pull') : null;
        return {
          ok: true,
          stdout: JSON.stringify({ pulled: true, output: pullStep.stdout.trim(), build }),
          stderr: '',
        };
      }

      throw new Error(`Unsupported git action: ${gitAction}`);
    }

    case 'site.build': {
      const name = validateName(params.name, 'site name');
      const result = await runSiteBuild(name, 'manual');
      return {
        ok: result.queued ? true : Boolean(result.ok),
        stdout: JSON.stringify(result),
        stderr: result.ok === false ? 'One or more build steps failed; inspect step logs' : '',
      };
    }

    case 'site.fixPermissions': {
      const name = validateName(params.name, 'site name');
      const rootDir = `/var/www/${name}`;
      if (!fs.existsSync(rootDir)) {
        throw new Error(`Site "${name}" directory does not exist`);
      }
      const siteRoot = fs.realpathSync(rootDir);
      const siteType = getSiteTypeFromVhost(name);
      const summary = applySitePermissions(siteRoot, siteType, {
        ensureFrameworkDirs: true,
      });
      return {
        ok: true,
        stdout: JSON.stringify(summary),
        stderr: '',
      };
    }

    case 'site.buildStatus': {
      const name = validateName(params.name, 'site name');
      return {
        ok: true,
        stdout: JSON.stringify({
          name,
          type: getSiteTypeFromVhost(name),
          building: activeBuilds.has(name),
          watch: isSiteWatcherEnabled(name),
          lastBuild: readBuildStatus(name),
        }),
        stderr: '',
      };
    }

    case 'site.watch': {
      const name = validateName(params.name, 'site name');
      if (params.enabled === undefined) {
        return {
          ok: true,
          stdout: JSON.stringify({ name, watch: isSiteWatcherEnabled(name) }),
          stderr: '',
        };
      }
      if (Boolean(params.enabled)) {
        const res = enableSiteWatcher(name, true);
        return { ok: true, stdout: JSON.stringify({ name, watch: true, ...res }), stderr: '' };
      }
      disableSiteWatcher(name, true);
      return { ok: true, stdout: JSON.stringify({ name, watch: false }), stderr: '' };
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
    socket.setTimeout(BUILD_TIMEOUT_MS + 10_000);

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
    startPersistedWatchers();
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
  resolveJailedPath,
  NAME_RE,
  DOMAIN_RE,
  UNIT_RE,
};

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

  const priority = ['apache2', 'control-agent', 'dietpi-panel'];
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

async function runBin(binPath, args, timeout = DEFAULT_TIMEOUT_MS) {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      shell: false,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        BASE_DOMAIN,
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
      return { ok: true, stdout: res.stdout.trim(), stderr: res.stderr };
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
      if (fs.existsSync(vhostPath)) {
        const vhostContent = fs.readFileSync(vhostPath, 'utf8');
        if (vhostContent.includes('# dietpi-panel:type=dbonly')) {
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

      return {
        ok: true,
        stdout: JSON.stringify({ name, archivedTo: trashDir, removedDbonlyVhost }),
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
      return { ok: res.ok, stdout: res.stdout.trim(), stderr: res.stderr };
    }

    case 'site.list': {
      const res = await runBin('/usr/local/bin/listsites', []);
      return { ok: res.ok, stdout: res.stdout.trim() || '[]', stderr: res.stderr };
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

      return {
        ok: true,
        stdout: JSON.stringify({ name, archivedTo: archiveDir }),
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
      if (unit === 'control-agent' || unit === 'dietpi-panel') {
        // Respond first so the caller receives confirmation before systemd restarts the process
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
        }, 200);
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
  NAME_RE,
  DOMAIN_RE,
  UNIT_RE,
};

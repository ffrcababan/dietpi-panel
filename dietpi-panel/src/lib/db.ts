import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  must_change_password: number;
  session_version: number;
  created_at: string;
  updated_at: string;
}

function getDbPath(): string {
  return process.env.DB_PATH || '/srv/db/_panel/panel.sqlite';
}

export function sqlLiteral(val: string | number | boolean | null): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'boolean') {
    return val ? '1' : '0';
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error('Invalid non-finite numeric parameter');
    }
    return String(val);
  }
  if (typeof val === 'string') {
    if (val.length === 0) {
      return "''";
    }
    // Encode strings strictly as UTF-8 hex blobs cast to TEXT to eliminate SQL/CLI injection
    const hex = Buffer.from(val, 'utf8').toString('hex');
    return `CAST(X'${hex}' AS TEXT)`;
  }
  throw new Error(`Unsupported SQL parameter type: ${typeof val}`);
}

let schemaInitializedForPath: string | null = null;

async function ensureSchema(dbPath: string): Promise<void> {
  if (schemaInitializedForPath === dbPath) {
    return;
  }
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }

  const initSql = `
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
  `;

  await execFileAsync('sqlite3', ['-bail', '-cmd', '.timeout 5000', dbPath, initSql], {
    shell: false,
    timeout: 10_000,
  });
  schemaInitializedForPath = dbPath;
}

async function runQueryJson<T>(sql: string): Promise<T[]> {
  const dbPath = getDbPath();
  await ensureSchema(dbPath);
  const { stdout } = await execFileAsync(
    'sqlite3',
    ['-bail', '-cmd', '.timeout 5000', '-json', dbPath, sql],
    {
      shell: false,
      timeout: 10_000,
    }
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  return JSON.parse(trimmed) as T[];
}

async function runExec(sql: string): Promise<void> {
  const dbPath = getDbPath();
  await ensureSchema(dbPath);
  await execFileAsync('sqlite3', ['-bail', '-cmd', '.timeout 5000', dbPath, sql], {
    shell: false,
    timeout: 10_000,
  });
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  const rows = await runQueryJson<UserRow>(
    `SELECT id, username, password_hash, totp_secret, must_change_password, session_version, created_at, updated_at
     FROM users
     WHERE username = ${sqlLiteral(username)}
     LIMIT 1;`
  );
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const rows = await runQueryJson<UserRow>(
    `SELECT id, username, password_hash, totp_secret, must_change_password, session_version, created_at, updated_at
     FROM users
     WHERE id = ${sqlLiteral(id)}
     LIMIT 1;`
  );
  return rows[0] ?? null;
}

export async function updateUserPassword(
  id: number,
  newPasswordHash: string
): Promise<UserRow | null> {
  await runExec(
    `UPDATE users
     SET password_hash = ${sqlLiteral(newPasswordHash)},
         must_change_password = 0,
         session_version = session_version + 1,
         updated_at = datetime('now')
     WHERE id = ${sqlLiteral(id)};`
  );
  return getUserById(id);
}

export async function setUserTotpSecret(
  id: number,
  totpSecret: string | null
): Promise<UserRow | null> {
  await runExec(
    `UPDATE users
     SET totp_secret = ${sqlLiteral(totpSecret)},
         updated_at = datetime('now')
     WHERE id = ${sqlLiteral(id)};`
  );
  return getUserById(id);
}

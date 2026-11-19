import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UserRole } from './validation';

const execFileAsync = promisify(execFile);

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: UserRole;
  is_active: number;
  password_hash: string;
  totp_secret: string | null;
  must_change_password: number;
  session_version: number;
  created_at: string;
  updated_at: string;
}

export interface PublicUserSummary {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  siteCount: number;
  dbCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ResourceType = 'site' | 'database';

export interface ResourceOwnershipRow {
  resource_type: ResourceType;
  resource_name: string;
  owner_user_id: number;
  owner_username?: string;
  created_at: string;
}

const USER_SELECT_COLS =
  'id, username, display_name, email, role, is_active, password_hash, totp_secret, must_change_password, session_version, created_at, updated_at';

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
    const hex = Buffer.from(val, 'utf8').toString('hex');
    return `CAST(X'${hex}' AS TEXT)`;
  }
  throw new Error(`Unsupported SQL parameter type: ${typeof val}`);
}

let schemaInitializedForPath: string | null = null;
let schemaInitPromise: Promise<void> | null = null;

async function sqliteExecRaw(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'sqlite3',
    ['-bail', '-cmd', '.timeout 5000', dbPath, sql],
    {
      shell: false,
      timeout: 10_000,
    }
  );
  return stdout;
}

async function sqliteJsonRaw<T>(dbPath: string, sql: string): Promise<T[]> {
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

async function ensureSchema(dbPath: string): Promise<void> {
  if (schemaInitializedForPath === dbPath) {
    return;
  }
  if (schemaInitPromise) {
    await schemaInitPromise;
    if (schemaInitializedForPath === dbPath) return;
  }

  schemaInitPromise = (async () => {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    }

    const initSql = `
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
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
    `;
    await sqliteExecRaw(dbPath, initSql);

    // Idempotent column migrations for existing pre-multiuser installations
    const cols = await sqliteJsonRaw<{ name: string }>(
      dbPath,
      'PRAGMA table_info(users);'
    );
    const colNames = new Set(cols.map((c) => c.name));
    const alterStmts: string[] = [];

    if (!colNames.has('display_name')) {
      alterStmts.push(
        "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';"
      );
    }
    if (!colNames.has('email')) {
      alterStmts.push(
        "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';"
      );
    }
    if (!colNames.has('role')) {
      alterStmts.push(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';"
      );
    }
    if (!colNames.has('is_active')) {
      alterStmts.push(
        'ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;'
      );
    }

    if (alterStmts.length > 0) {
      await sqliteExecRaw(dbPath, alterStmts.join('\n'));
    }

    // Guarantee primary admin retains admin role and non-empty display name
    await sqliteExecRaw(
      dbPath,
      `
      UPDATE users
      SET role = 'admin',
          display_name = CASE WHEN display_name = '' THEN 'Administrator' ELSE display_name END
      WHERE username = 'admin';

      UPDATE users
      SET role = 'admin'
      WHERE (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1) = 0
        AND id = (SELECT id FROM users ORDER BY id ASC LIMIT 1);
      `
    );

    schemaInitializedForPath = dbPath;
  })();

  try {
    await schemaInitPromise;
  } finally {
    schemaInitPromise = null;
  }
}

async function runQueryJson<T>(sql: string): Promise<T[]> {
  const dbPath = getDbPath();
  await ensureSchema(dbPath);
  return sqliteJsonRaw<T>(dbPath, sql);
}

async function runExec(sql: string): Promise<void> {
  const dbPath = getDbPath();
  await ensureSchema(dbPath);
  await sqliteExecRaw(dbPath, `PRAGMA foreign_keys = ON;\n${sql}`);
}

export function normalizeUserRow(row: UserRow): UserRow {
  return {
    ...row,
    role: row.role === 'admin' ? 'admin' : 'user',
    display_name: row.display_name || '',
    email: row.email || '',
    is_active: row.is_active === 0 ? 0 : 1,
  };
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  const rows = await runQueryJson<UserRow>(
    `SELECT ${USER_SELECT_COLS}
     FROM users
     WHERE username = ${sqlLiteral(username.trim().toLowerCase())}
     LIMIT 1;`
  );
  return rows[0] ? normalizeUserRow(rows[0]) : null;
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const rows = await runQueryJson<UserRow>(
    `SELECT ${USER_SELECT_COLS}
     FROM users
     WHERE id = ${sqlLiteral(id)}
     LIMIT 1;`
  );
  return rows[0] ? normalizeUserRow(rows[0]) : null;
}

export async function listUsersWithResourceCounts(): Promise<PublicUserSummary[]> {
  const rows = await runQueryJson<{
    id: number;
    username: string;
    display_name: string;
    email: string;
    role: string;
    is_active: number;
    must_change_password: number;
    totp_enabled: number;
    site_count: number;
    db_count: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.email,
       u.role,
       u.is_active,
       u.must_change_password,
       CASE WHEN u.totp_secret IS NOT NULL AND u.totp_secret != '' THEN 1 ELSE 0 END AS totp_enabled,
       COALESCE(SUM(CASE WHEN ro.resource_type = 'site' THEN 1 ELSE 0 END), 0) AS site_count,
       COALESCE(SUM(CASE WHEN ro.resource_type = 'database' THEN 1 ELSE 0 END), 0) AS db_count,
       u.created_at,
       u.updated_at
     FROM users u
     LEFT JOIN resource_owners ro ON ro.owner_user_id = u.id
     GROUP BY u.id
     ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.id ASC;`
  );

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name || '',
    email: r.email || '',
    role: r.role === 'admin' ? 'admin' : 'user',
    isActive: r.is_active !== 0,
    mustChangePassword: r.must_change_password === 1,
    totpEnabled: r.totp_enabled === 1,
    siteCount: Number(r.site_count) || 0,
    dbCount: Number(r.db_count) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function countActiveAdmins(excludeUserId?: number): Promise<number> {
  const whereExclude =
    excludeUserId !== undefined ? ` AND id != ${sqlLiteral(excludeUserId)}` : '';
  const rows = await runQueryJson<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM users
     WHERE role = 'admin' AND is_active = 1${whereExclude};`
  );
  return Number(rows[0]?.cnt || 0);
}

export async function createUser(input: {
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  passwordHash: string;
  mustChangePassword?: boolean;
  isActive?: boolean;
}): Promise<UserRow> {
  await runExec(
    `INSERT INTO users (
       username, display_name, email, role, is_active, password_hash, must_change_password
     ) VALUES (
       ${sqlLiteral(input.username)},
       ${sqlLiteral(input.displayName)},
       ${sqlLiteral(input.email)},
       ${sqlLiteral(input.role)},
       ${sqlLiteral(input.isActive !== false)},
       ${sqlLiteral(input.passwordHash)},
       ${sqlLiteral(Boolean(input.mustChangePassword))}
     );`
  );
  const created = await getUserByUsername(input.username);
  if (!created) {
    throw new Error('Failed to retrieve created user');
  }
  return created;
}

export async function updateUserByAdmin(
  id: number,
  fields: {
    username?: string;
    displayName?: string;
    email?: string;
    role?: UserRole;
    isActive?: boolean;
    passwordHash?: string;
    mustChangePassword?: boolean;
    clearTotp?: boolean;
  }
): Promise<UserRow | null> {
  const assignments: string[] = [];
  let invalidateSession = false;

  if (fields.username !== undefined) {
    assignments.push(`username = ${sqlLiteral(fields.username)}`);
    invalidateSession = true;
  }
  if (fields.displayName !== undefined) {
    assignments.push(`display_name = ${sqlLiteral(fields.displayName)}`);
  }
  if (fields.email !== undefined) {
    assignments.push(`email = ${sqlLiteral(fields.email)}`);
  }
  if (fields.role !== undefined) {
    assignments.push(`role = ${sqlLiteral(fields.role)}`);
    invalidateSession = true;
  }
  if (fields.isActive !== undefined) {
    assignments.push(`is_active = ${sqlLiteral(fields.isActive)}`);
    if (!fields.isActive) invalidateSession = true;
  }
  if (fields.passwordHash !== undefined) {
    assignments.push(`password_hash = ${sqlLiteral(fields.passwordHash)}`);
    invalidateSession = true;
  }
  if (fields.mustChangePassword !== undefined) {
    assignments.push(`must_change_password = ${sqlLiteral(fields.mustChangePassword)}`);
    if (fields.mustChangePassword) invalidateSession = true;
  }
  if (fields.clearTotp) {
    assignments.push('totp_secret = NULL');
    invalidateSession = true;
  }

  if (assignments.length === 0) {
    return getUserById(id);
  }
  if (invalidateSession) {
    assignments.push('session_version = session_version + 1');
  }
  assignments.push("updated_at = datetime('now')");

  await runExec(
    `UPDATE users SET ${assignments.join(', ')} WHERE id = ${sqlLiteral(id)};`
  );
  return getUserById(id);
}

export async function updateUserProfile(
  id: number,
  fields: {
    username?: string;
    displayName: string;
    email: string;
  }
): Promise<{ user: UserRow | null; usernameChanged: boolean }> {
  const existing = await getUserById(id);
  if (!existing) return { user: null, usernameChanged: false };

  const assignments: string[] = [
    `display_name = ${sqlLiteral(fields.displayName)}`,
    `email = ${sqlLiteral(fields.email)}`,
    "updated_at = datetime('now')",
  ];

  const usernameChanged =
    Boolean(fields.username) && fields.username !== existing.username;
  if (usernameChanged && fields.username) {
    assignments.push(`username = ${sqlLiteral(fields.username)}`);
    assignments.push('session_version = session_version + 1');
  }

  await runExec(
    `UPDATE users SET ${assignments.join(', ')} WHERE id = ${sqlLiteral(id)};`
  );
  return { user: await getUserById(id), usernameChanged };
}

export async function deleteUserById(
  id: number,
  reassignResourcesToUserId?: number
): Promise<boolean> {
  const existing = await getUserById(id);
  if (!existing) return false;

  if (reassignResourcesToUserId !== undefined && reassignResourcesToUserId !== id) {
    await runExec(`
      BEGIN IMMEDIATE;
      UPDATE resource_owners
      SET owner_user_id = ${sqlLiteral(reassignResourcesToUserId)}
      WHERE owner_user_id = ${sqlLiteral(id)};
      DELETE FROM users WHERE id = ${sqlLiteral(id)};
      COMMIT;
    `);
  } else {
    await runExec(`
      BEGIN IMMEDIATE;
      DELETE FROM resource_owners WHERE owner_user_id = ${sqlLiteral(id)};
      DELETE FROM users WHERE id = ${sqlLiteral(id)};
      COMMIT;
    `);
  }
  return true;
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

// ---------------------------------------------------------------------------
// Resource Ownership Helpers (Strict Per-User Isolation for Sites & Databases)
// ---------------------------------------------------------------------------

export async function getResourceOwner(
  resourceType: ResourceType,
  resourceName: string
): Promise<ResourceOwnershipRow | null> {
  const rows = await runQueryJson<ResourceOwnershipRow>(
    `SELECT ro.resource_type, ro.resource_name, ro.owner_user_id, u.username AS owner_username, ro.created_at
     FROM resource_owners ro
     LEFT JOIN users u ON u.id = ro.owner_user_id
     WHERE ro.resource_type = ${sqlLiteral(resourceType)}
       AND ro.resource_name = ${sqlLiteral(resourceName)}
     LIMIT 1;`
  );
  return rows[0] ?? null;
}

export async function setResourceOwner(
  resourceType: ResourceType,
  resourceName: string,
  ownerUserId: number
): Promise<void> {
  await runExec(
    `INSERT INTO resource_owners (resource_type, resource_name, owner_user_id)
     VALUES (${sqlLiteral(resourceType)}, ${sqlLiteral(resourceName)}, ${sqlLiteral(ownerUserId)})
     ON CONFLICT(resource_type, resource_name) DO UPDATE SET
       owner_user_id = excluded.owner_user_id,
       created_at = datetime('now');`
  );
}

export async function deleteResourceOwner(
  resourceType: ResourceType,
  resourceName: string
): Promise<void> {
  await runExec(
    `DELETE FROM resource_owners
     WHERE resource_type = ${sqlLiteral(resourceType)}
       AND resource_name = ${sqlLiteral(resourceName)};`
  );
}

export async function isResourceOwner(
  resourceType: ResourceType,
  resourceName: string,
  userId: number
): Promise<boolean> {
  const rows = await runQueryJson<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM resource_owners
     WHERE resource_type = ${sqlLiteral(resourceType)}
       AND resource_name = ${sqlLiteral(resourceName)}
       AND owner_user_id = ${sqlLiteral(userId)};`
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

export async function getOwnedResourceNames(
  resourceType: ResourceType,
  userId: number
): Promise<Set<string>> {
  const rows = await runQueryJson<{ resource_name: string }>(
    `SELECT resource_name
     FROM resource_owners
     WHERE resource_type = ${sqlLiteral(resourceType)}
       AND owner_user_id = ${sqlLiteral(userId)};`
  );
  return new Set(rows.map((r) => r.resource_name));
}

export async function getAllResourceOwnerMap(
  resourceType: ResourceType
): Promise<Map<string, { ownerId: number; ownerUsername: string }>> {
  const rows = await runQueryJson<{
    resource_name: string;
    owner_user_id: number;
    owner_username: string | null;
  }>(
    `SELECT ro.resource_name, ro.owner_user_id, u.username AS owner_username
     FROM resource_owners ro
     LEFT JOIN users u ON u.id = ro.owner_user_id
     WHERE ro.resource_type = ${sqlLiteral(resourceType)};`
  );
  const map = new Map<string, { ownerId: number; ownerUsername: string }>();
  for (const r of rows) {
    if (r.owner_username) {
      map.set(r.resource_name, {
        ownerId: r.owner_user_id,
        ownerUsername: r.owner_username,
      });
    }
  }
  return map;
}

export async function getUserOwnedResources(
  userId: number
): Promise<{ sites: string[]; databases: string[] }> {
  const rows = await runQueryJson<{
    resource_type: ResourceType;
    resource_name: string;
  }>(
    `SELECT resource_type, resource_name
     FROM resource_owners
     WHERE owner_user_id = ${sqlLiteral(userId)}
     ORDER BY resource_name ASC;`
  );
  const sites: string[] = [];
  const databases: string[] = [];
  for (const r of rows) {
    if (r.resource_type === 'site') sites.push(r.resource_name);
    else if (r.resource_type === 'database') databases.push(r.resource_name);
  }
  return { sites, databases };
}

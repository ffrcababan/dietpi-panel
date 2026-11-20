import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireResourceAccess } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface DbColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  defaultValue: string | null;
  pk: number;
}

export interface DbIndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

export interface DbForeignKeyInfo {
  id: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

export interface DbTriggerInfo {
  name: string;
  sql: string;
}

export interface DbTableInfo {
  name: string;
  type: 'table' | 'view';
  sql: string | null;
  rowCount: number;
  withoutRowId: boolean;
  hasEditableKey: boolean;
  primaryKey: string[];
  columns: DbColumnInfo[];
  indexes: DbIndexInfo[];
  foreignKeys: DbForeignKeyInfo[];
  triggers?: DbTriggerInfo[];
}

export interface DbSchemaResponse {
  ok: boolean;
  sqliteVersion: string;
  journalMode?: string;
  dbSizeBytes?: number;
  tables: DbTableInfo[];
}

export interface DbBlobCell {
  __blob: true;
  bytes: number;
  base64: string;
}

export type DbCellValue = string | number | boolean | null | DbBlobCell;

export interface DbRowKey {
  rowid?: string;
  pk?: Record<string, DbCellValue>;
}

export interface DbRowItem {
  rowKey: DbRowKey | null;
  cells: Record<string, DbCellValue>;
}

export interface DbRowsResponse {
  ok: boolean;
  table: string;
  type: 'table' | 'view';
  columns: DbColumnInfo[];
  hasEditableKey: boolean;
  page: number;
  pageSize: number;
  totalRows: number;
  rows: DbRowItem[];
}

export interface DbScriptStatementResult {
  index: number;
  sql: string;
  kind: 'rows' | 'mutation';
  columns?: string[];
  rows?: DbCellValue[][];
  rowCount?: number;
  truncated?: boolean;
  changes?: number;
  durationMs: number;
}

export interface DbScriptResponse {
  ok: boolean;
  requiresConfirmation?: boolean;
  warnings?: string[];
  rolledBack?: boolean;
  results: DbScriptStatementResult[];
}

const MUTATING_OPS = new Set([
  'rows.insert',
  'rows.update',
  'rows.delete',
  'table.create',
  'table.drop',
  'columns.add',
  'columns.update',
  'columns.drop',
  'script.exec',
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> }
) {
  const { name } = await context.params;
  const nameCheck = validateResourceName(name, 'database name');
  const auth = await requireResourceAccess(
    undefined,
    'database',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'schema';

  try {
    if (action === 'rows') {
      const table = url.searchParams.get('table') || '';
      if (!table) {
        return NextResponse.json({ error: 'table parameter is required' }, { status: 400 });
      }
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(
        200,
        Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '50', 10) || 50)
      );
      const search = url.searchParams.get('search') || '';
      const sortBy = url.searchParams.get('sortBy') || '';
      const sortDir = url.searchParams.get('sortDir') === 'DESC' ? 'DESC' : 'ASC';

      const resp = await callControlAgent('db.inspect', {
        name: nameCheck.value,
        op: 'rows.list',
        table,
        page,
        pageSize,
        search,
        sortBy,
        sortDir,
      });
      if (!resp.ok) {
        return NextResponse.json(
          { error: resp.stderr || 'Failed to read table rows' },
          { status: 400 }
        );
      }
      const result = parseAgentJson<DbRowsResponse>(resp, 'Invalid rows response');
      return NextResponse.json(result, { headers: NO_STORE_HEADERS });
    }

    if (action === 'schema') {
      const resp = await callControlAgent('db.inspect', {
        name: nameCheck.value,
        op: 'schema',
      });
      if (!resp.ok) {
        return NextResponse.json(
          { error: resp.stderr || 'Failed to inspect database schema' },
          { status: 400 }
        );
      }
      const result = parseAgentJson<DbSchemaResponse>(resp, 'Invalid schema response');
      return NextResponse.json(result, { headers: NO_STORE_HEADERS });
    }

    return NextResponse.json(
      { error: 'Unsupported inspect action (expected schema or rows)' },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database inspect failed' },
      { status: 502 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> }
) {
  const { name } = await context.params;
  const nameCheck = validateResourceName(name, 'database name');
  const auth = await requireResourceAccess(
    request,
    'database',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const op = typeof body.op === 'string' ? body.op.trim() : '';
  if (!MUTATING_OPS.has(op)) {
    return NextResponse.json(
      { error: `Unsupported database operation: ${op || '(empty)'}` },
      { status: 400 }
    );
  }

  if (op === 'script.exec') {
    if (typeof body.sql !== 'string' || !body.sql.trim()) {
      return NextResponse.json({ error: 'SQL script cannot be empty' }, { status: 400 });
    }
    if (body.sql.length > 512 * 1024) {
      return NextResponse.json(
        { error: 'SQL script exceeds 512 KB limit' },
        { status: 400 }
      );
    }
  }

  try {
    const resp = await callControlAgent('db.mutate', {
      ...body,
      name: nameCheck.value,
      op,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || `Database operation "${op}" failed` },
        { status: 400 }
      );
    }
    const result = parseAgentJson<Record<string, unknown>>(
      resp,
      'Invalid database studio response'
    );
    return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database mutation failed' },
      { status: 502 }
    );
  }
}

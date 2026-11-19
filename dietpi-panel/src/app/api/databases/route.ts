import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export interface DatabaseRecord {
  name: string;
  sizeBytes: number;
  modified: string;
  domain: string;
  siteType: string;
}

export interface CreateDatabaseResult {
  name: string;
  domain: string;
  dbPath: string;
  apiKey: string;
  vhost: string;
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('db.list');
    const databases = parseAgentJson<DatabaseRecord[]>(
      resp,
      'Failed to list databases'
    );
    return NextResponse.json({ databases });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list databases' },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const check = validateResourceName(body.name, 'database name');
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  try {
    const resp = await callControlAgent('db.create', { name: check.value });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to create database' },
        { status: 400 }
      );
    }
    const created = parseAgentJson<CreateDatabaseResult>(
      resp,
      'Invalid create response from control agent'
    );
    return NextResponse.json({ database: created }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create database' },
      { status: 502 }
    );
  }
}

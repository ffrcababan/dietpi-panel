import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type TunnelActionResult,
} from '@/lib/agent';
import { requireSession } from '@/lib/auth';
import {
  getAllResourceOwnerMap,
  getOwnedResourceNames,
  getResourceOwner,
  setResourceOwner,
} from '@/lib/db';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface DatabaseRecord {
  name: string;
  sizeBytes: number;
  modified: string;
  domain: string;
  siteType: string;
  ownerUsername?: string | null;
}

export interface CreateDatabaseResult {
  name: string;
  domain: string;
  dbPath: string;
  apiKey: string;
  vhost: string;
  tunnel?: TunnelActionResult;
}

export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('db.list');
    const allDatabases = parseAgentJson<DatabaseRecord[]>(
      resp,
      'Failed to list databases'
    );

    if (auth.user.role === 'admin') {
      const ownerMap = await getAllResourceOwnerMap('database');
      const databases = allDatabases.map((d) => ({
        ...d,
        ownerUsername: ownerMap.get(d.name)?.ownerUsername ?? null,
      }));
      return NextResponse.json({ databases }, { headers: NO_STORE_HEADERS });
    }

    const ownedNames = await getOwnedResourceNames('database', auth.user.id);
    const scopedDatabases = allDatabases
      .filter((d) => ownedNames.has(d.name))
      .map((d) => ({ ...d, ownerUsername: auth.user.username }));

    return NextResponse.json(
      { databases: scopedDatabases },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list databases' },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
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
    const [existingDbOwner, existingSiteOwner, dbsResp, sitesResp] =
      await Promise.all([
        getResourceOwner('database', check.value),
        getResourceOwner('site', check.value),
        callControlAgent('db.list'),
        callControlAgent('site.list'),
      ]);

    const currentDbs = dbsResp.ok
      ? parseAgentJson<Array<{ name: string }>>(dbsResp, 'Failed to verify DB availability')
      : [];
    const currentSites = sitesResp.ok
      ? parseAgentJson<Array<{ name: string; type: string }>>(
          sitesResp,
          'Failed to verify site availability'
        )
      : [];

    if (currentDbs.some((d) => d.name === check.value)) {
      return NextResponse.json(
        { error: `Database "${check.value}" already exists` },
        { status: 409 }
      );
    }

    if (
      auth.user.role !== 'admin' &&
      existingDbOwner &&
      existingDbOwner.owner_user_id !== auth.user.id
    ) {
      return NextResponse.json(
        { error: 'This database name is already registered to another user' },
        { status: 403 }
      );
    }

    const siteExistsOnDisk = currentSites.some(
      (s) => s.name === check.value && s.type !== 'dbonly'
    );
    if (
      auth.user.role !== 'admin' &&
      ((existingSiteOwner && existingSiteOwner.owner_user_id !== auth.user.id) ||
        (siteExistsOnDisk && existingSiteOwner?.owner_user_id !== auth.user.id))
    ) {
      return NextResponse.json(
        { error: 'This name conflicts with an existing site owned by another user' },
        { status: 403 }
      );
    }

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

    await setResourceOwner('database', created.name, auth.user.id);
    return NextResponse.json(
      { database: created },
      { status: 201, headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create database' },
      { status: 502 }
    );
  }
}

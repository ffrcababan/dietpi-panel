import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type TunnelActionResult,
} from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import {
  FRAMEWORK_PRESETS,
  validateDomainName,
  validateResourceName,
  validateSiteType,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface SiteRecord {
  name: string;
  serverName: string;
  docroot: string;
  type: string;
  ssl: boolean;
  port: number | null;
  hasDb: boolean;
  isPanel: boolean;
  tunnel?: boolean;
  watch?: boolean;
}

export interface CreateSiteResponse {
  name: string;
  type: string;
  domain: string;
  docroot: string;
  port: number | null;
  database: {
    name: string;
    domain: string;
    dbPath: string;
    apiKey: string;
    vhost: string;
  } | null;
  existingDb: boolean;
  envFile: string | null;
  dbError: string | null;
  watch: boolean;
  tunnel?: TunnelActionResult;
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('site.list');
    const sites = parseAgentJson<SiteRecord[]>(resp, 'Failed to list sites');
    return NextResponse.json({ sites }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list sites' },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let body: {
    name?: unknown;
    type?: unknown;
    domain?: unknown;
    port?: unknown;
    createDb?: unknown;
    watch?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const nameCheck = validateResourceName(body.name, 'site name');
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  const typeCheck = validateSiteType(body.type);
  if (!typeCheck.ok) {
    return NextResponse.json({ error: typeCheck.error }, { status: 400 });
  }

  let domain: string | undefined;
  if (typeof body.domain === 'string' && body.domain.trim() !== '') {
    const domainCheck = validateDomainName(body.domain);
    if (!domainCheck.ok) {
      return NextResponse.json({ error: domainCheck.error }, { status: 400 });
    }
    domain = domainCheck.value;
  }

  let port: number | undefined;
  if (body.port !== undefined && body.port !== null && body.port !== '') {
    const parsedPort = Number(body.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 3001 || parsedPort > 39999) {
      return NextResponse.json(
        { error: 'Port must be an integer between 3001 and 39999' },
        { status: 400 }
      );
    }
    if (!FRAMEWORK_PRESETS[typeCheck.value].hasPort) {
      return NextResponse.json(
        { error: `Custom port is not used by ${typeCheck.value} sites` },
        { status: 400 }
      );
    }
    port = parsedPort;
  }

  const createDb = body.createDb !== false;
  const watch = Boolean(body.watch);

  try {
    const resp = await callControlAgent('site.create', {
      name: nameCheck.value,
      type: typeCheck.value,
      domain,
      port,
      createDb,
      watch,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to create site' },
        { status: 400 }
      );
    }
    const site = parseAgentJson<CreateSiteResponse>(
      resp,
      'Invalid create site response'
    );
    return NextResponse.json({ site }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create site' },
      { status: 502 }
    );
  }
}

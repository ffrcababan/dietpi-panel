import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import {
  validateDomainName,
  validateResourceName,
  validateSiteType,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

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
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('site.list');
    const sites = parseAgentJson<SiteRecord[]>(resp, 'Failed to list sites');
    return NextResponse.json({ sites });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list sites' },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let body: { name?: unknown; type?: unknown; domain?: unknown; port?: unknown };
  try {
    body = (await request.json()) as {
      name?: unknown;
      type?: unknown;
      domain?: unknown;
      port?: unknown;
    };
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
    if (typeCheck.value !== 'nextjs') {
      return NextResponse.json(
        { error: 'Custom port is only applicable to nextjs sites' },
        { status: 400 }
      );
    }
    port = parsedPort;
  }

  try {
    const resp = await callControlAgent('site.create', {
      name: nameCheck.value,
      type: typeCheck.value,
      domain,
      port,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to create site' },
        { status: 400 }
      );
    }
    const site = parseAgentJson<Record<string, unknown>>(
      resp,
      'Invalid create site response'
    );
    return NextResponse.json({ site }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create site' },
      { status: 502 }
    );
  }
}

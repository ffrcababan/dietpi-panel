import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type TunnelActionResult,
} from '@/lib/agent';
import { requireSession } from '@/lib/auth';
import { getOwnedResourceNames } from '@/lib/db';
import { validateDomainName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  let body: { domain?: unknown };
  try {
    body = (await request.json()) as { domain?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const check = validateDomainName(body.domain);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  try {
    if (auth.user.role !== 'admin') {
      const [ownedSites, sitesResp] = await Promise.all([
        getOwnedResourceNames('site', auth.user.id),
        callControlAgent('site.list'),
      ]);
      const ownedDomains = new Set(
        (sitesResp.ok
          ? parseAgentJson<Array<{ name: string; serverName: string; isPanel: boolean }>>(
              sitesResp,
              'Failed to verify site ownership'
            )
          : []
        )
          .filter((s) => !s.isPanel && ownedSites.has(s.name))
          .map((s) => s.serverName.toLowerCase())
      );

      if (!ownedDomains.has(check.value.toLowerCase())) {
        return NextResponse.json(
          { error: 'Access denied: you can only route domains for your own sites' },
          { status: 403 }
        );
      }
    }

    const resp = await callControlAgent('tunnel.route', { domain: check.value });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to route Cloudflare tunnel' },
        { status: 400 }
      );
    }
    const tunnel = parseAgentJson<TunnelActionResult>(
      resp,
      'Invalid tunnel route response'
    );
    return NextResponse.json({ tunnel });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to route tunnel' },
      { status: 502 }
    );
  }
}

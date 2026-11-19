import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireSession } from '@/lib/auth';
import { getOwnedResourceNames } from '@/lib/db';
import { validateDomainName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  let body: { domain?: unknown; dryRun?: unknown };
  try {
    body = (await request.json()) as { domain?: unknown; dryRun?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const check = validateDomainName(body.domain);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const dryRun = Boolean(body.dryRun);

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
          { error: 'Access denied: you can only issue certificates for your own site domains' },
          { status: 403 }
        );
      }
    }

    const resp = await callControlAgent('cert', {
      domain: check.value,
      dryRun,
    });
    return NextResponse.json(
      {
        ok: resp.ok,
        domain: check.value,
        dryRun,
        stdout: resp.stdout,
        stderr: resp.stderr,
      },
      { status: resp.ok ? 200 : 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to run certbot' },
      { status: 502 }
    );
  }
}

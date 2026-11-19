import { NextResponse } from 'next/server';
import { callControlAgent } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateDomainName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
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

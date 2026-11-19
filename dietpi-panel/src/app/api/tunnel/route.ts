import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type TunnelActionResult,
} from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateDomainName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
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

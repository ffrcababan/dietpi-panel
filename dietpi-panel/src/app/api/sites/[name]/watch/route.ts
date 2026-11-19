import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: { name: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const nameCheck = validateResourceName(context.params.name, 'site name');
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const resp = await callControlAgent('site.watch', {
      name: nameCheck.value,
      enabled: Boolean(body.enabled),
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to update watcher' },
        { status: 400 }
      );
    }
    const result = parseAgentJson<{ name: string; watch: boolean; watchedDirs?: number }>(
      resp,
      'Invalid watch response'
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update watcher' },
      { status: 502 }
    );
  }
}

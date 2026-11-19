import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireResourceAccess } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: { name: string } }
) {
  const nameCheck = validateResourceName(context.params.name, 'site name');
  const auth = await requireResourceAccess(
    request,
    'site',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

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

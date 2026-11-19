import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireResourceAccess } from '@/lib/auth';
import { deleteResourceOwner } from '@/lib/db';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: { name: string } }
) {
  const check = validateResourceName(context.params.name, 'site name');
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const auth = await requireResourceAccess(request, 'site', check.value);
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('site.delete', { name: check.value });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to delete site' },
        { status: 400 }
      );
    }
    await deleteResourceOwner('site', check.value);
    const deleted = parseAgentJson<{ name: string; archivedTo: string }>(
      resp,
      'Invalid site delete response'
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete site' },
      { status: 502 }
    );
  }
}

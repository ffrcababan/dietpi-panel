import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: { name: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const check = validateResourceName(context.params.name, 'database name');
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  try {
    const resp = await callControlAgent('db.delete', { name: check.value });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to archive database' },
        { status: 400 }
      );
    }
    const deleted = parseAgentJson<{ name: string; archivedTo: string }>(
      resp,
      'Failed to parse delete response'
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete database' },
      { status: 502 }
    );
  }
}

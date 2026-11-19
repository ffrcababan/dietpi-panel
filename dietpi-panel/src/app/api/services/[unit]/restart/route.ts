import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateUnitName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: { unit: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const check = validateUnitName(context.params.unit);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  try {
    const resp = await callControlAgent('service.restart', { unit: check.value });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || `Failed to restart ${check.value}` },
        { status: 400 }
      );
    }
    const result = parseAgentJson<{
      unit: string;
      restarted: boolean;
      scheduled: boolean;
    }>(resp, 'Failed to parse service restart response');
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to restart service' },
      { status: 502 }
    );
  }
}

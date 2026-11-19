import { NextResponse } from 'next/server';
import { callControlAgent } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateUnitName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const unitParam = url.searchParams.get('unit') || 'apache2';
  const linesParam = url.searchParams.get('lines') || '100';

  const unitCheck = validateUnitName(unitParam);
  if (!unitCheck.ok) {
    return NextResponse.json({ error: unitCheck.error }, { status: 400 });
  }

  const lines = Number.parseInt(linesParam, 10);
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
    return NextResponse.json(
      { error: 'lines query parameter must be an integer between 1 and 1000' },
      { status: 400 }
    );
  }

  try {
    const resp = await callControlAgent('logs', {
      unit: unitCheck.value,
      lines,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to read logs' },
        { status: 400 }
      );
    }
    return NextResponse.json({
      unit: unitCheck.value,
      lines,
      output: resp.stdout,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch logs' },
      { status: 502 }
    );
  }
}

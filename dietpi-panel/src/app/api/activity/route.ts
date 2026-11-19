import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export interface ActivityEntry {
  timestamp: string;
  action: string;
  ok: boolean;
  params: Record<string, unknown>;
  detail: string;
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const linesRaw = url.searchParams.get('lines') || '30';
  const lines = Math.min(200, Math.max(1, Number.parseInt(linesRaw, 10) || 30));
  const includeReads = url.searchParams.get('all') === 'true';

  try {
    const resp = await callControlAgent('activity.list', { lines, includeReads });
    const entries = parseAgentJson<ActivityEntry[]>(
      resp,
      'Failed to load activity feed'
    );
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load activity' },
      { status: 502 }
    );
  }
}

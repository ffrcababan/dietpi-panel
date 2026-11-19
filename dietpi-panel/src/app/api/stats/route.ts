import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export interface PanelStats {
  dbCount: number;
  siteCount: number;
  totalVhosts: number;
  apacheActive: boolean;
  disk: {
    dbDirBytes: number;
    fsTotalBytes: number;
    fsUsedBytes: number;
    fsAvailBytes: number;
    fsUsedPercent: number;
  };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('stats');
    const stats = parseAgentJson<PanelStats>(resp, 'Failed to fetch system statistics');
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch stats' },
      { status: 502 }
    );
  }
}

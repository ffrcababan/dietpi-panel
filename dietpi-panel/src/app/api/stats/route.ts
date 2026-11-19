import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireSession } from '@/lib/auth';
import { getOwnedResourceNames } from '@/lib/db';

export const dynamic = 'force-dynamic';

export interface PanelStats {
  dbCount: number;
  siteCount: number;
  totalVhosts: number;
  apacheActive: boolean;
  scopedToUser?: boolean;
  disk: {
    dbDirBytes: number;
    fsTotalBytes: number;
    fsUsedBytes: number;
    fsAvailBytes: number;
    fsUsedPercent: number;
  } | null;
}

export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('stats');
    const stats = parseAgentJson<PanelStats>(resp, 'Failed to fetch system statistics');

    if (auth.user.role === 'admin') {
      return NextResponse.json(stats, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          Pragma: 'no-cache',
        },
      });
    }

    // Scope counts strictly to the authenticated user's own sites & databases
    const [ownedSites, ownedDbs, sitesResp, dbsResp] = await Promise.all([
      getOwnedResourceNames('site', auth.user.id),
      getOwnedResourceNames('database', auth.user.id),
      callControlAgent('site.list'),
      callControlAgent('db.list'),
    ]);

    const activeSites = sitesResp.ok
      ? parseAgentJson<Array<{ name: string; type: string; isPanel: boolean }>>(
          sitesResp,
          'Failed to inspect sites'
        ).filter((s) => !s.isPanel && s.type !== 'dbonly' && ownedSites.has(s.name))
      : [];

    const activeDbs = dbsResp.ok
      ? parseAgentJson<Array<{ name: string }>>(dbsResp, 'Failed to inspect databases')
          .filter((d) => ownedDbs.has(d.name))
      : [];

    const scopedStats: PanelStats = {
      dbCount: activeDbs.length,
      siteCount: activeSites.length,
      totalVhosts: activeSites.length,
      apacheActive: stats.apacheActive,
      scopedToUser: true,
      disk: null,
    };

    return NextResponse.json(scopedStats, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch stats' },
      { status: 502 }
    );
  }
}

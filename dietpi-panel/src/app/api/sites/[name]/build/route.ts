import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type SiteBuildRecord,
} from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { validateResourceName } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface SiteBuildStatusResponse {
  name: string;
  type: string;
  building: boolean;
  watch: boolean;
  lastBuild: SiteBuildRecord | null;
}

export async function GET(
  _request: Request,
  context: { params: { name: string } }
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const nameCheck = validateResourceName(context.params.name, 'site name');
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  try {
    const resp = await callControlAgent('site.buildStatus', { name: nameCheck.value });
    const status = parseAgentJson<SiteBuildStatusResponse>(
      resp,
      'Failed to read build status'
    );
    return NextResponse.json(status, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Build status failed' },
      { status: 502 }
    );
  }
}

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

  try {
    const resp = await callControlAgent('site.build', { name: nameCheck.value });
    let build: SiteBuildRecord | null = null;
    try {
      build = resp.stdout ? (JSON.parse(resp.stdout) as SiteBuildRecord) : null;
    } catch {
      build = null;
    }
    return NextResponse.json(
      { ok: resp.ok, build, error: resp.ok ? undefined : resp.stderr || 'Build failed' },
      { status: resp.ok ? 200 : 400, headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to run build' },
      { status: 502 }
    );
  }
}

import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type SiteBuildRecord,
} from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import {
  validateGitBranch,
  validateGitUrl,
  validateResourceName,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface GitStatus {
  initialized: boolean;
  remote: string;
  branch: string;
  status: string;
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
    const resp = await callControlAgent('site.git', {
      name: nameCheck.value,
      action: 'status',
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to inspect git status' },
        { status: 400 }
      );
    }
    const git = parseAgentJson<GitStatus>(resp, 'Invalid git status response');
    return NextResponse.json({ git }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Git status failed' },
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

  let body: {
    action?: unknown;
    repoUrl?: unknown;
    branch?: unknown;
    triggerBuild?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action !== 'clone' && body.action !== 'pull') {
    return NextResponse.json({ error: 'action must be clone or pull' }, { status: 400 });
  }

  const branchCheck = validateGitBranch(body.branch);
  if (!branchCheck.ok) {
    return NextResponse.json({ error: branchCheck.error }, { status: 400 });
  }

  let repoUrl: string | undefined;
  if (body.action === 'clone') {
    const urlCheck = validateGitUrl(body.repoUrl);
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
    repoUrl = urlCheck.value;
  }

  try {
    const resp = await callControlAgent('site.git', {
      name: nameCheck.value,
      action: body.action,
      repoUrl,
      branch: branchCheck.value,
      triggerBuild: body.triggerBuild !== false,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || `git ${body.action} failed` },
        { status: 400 }
      );
    }
    const result = parseAgentJson<{
      cloned?: boolean;
      pulled?: boolean;
      build?: SiteBuildRecord | null;
    }>(resp, 'Invalid git response');
    return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Git action failed' },
      { status: 502 }
    );
  }
}

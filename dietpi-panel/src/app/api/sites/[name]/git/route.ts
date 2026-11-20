import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type SiteBuildRecord,
} from '@/lib/agent';
import { requireResourceAccess } from '@/lib/auth';
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
  hasSavedToken?: boolean;
  savedUsername?: string;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> }
) {
  const { name } = await context.params;
  const nameCheck = validateResourceName(name, 'site name');
  const auth = await requireResourceAccess(
    undefined,
    'site',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

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
  context: { params: Promise<{ name: string }> }
) {
  const { name } = await context.params;
  const nameCheck = validateResourceName(name, 'site name');
  const auth = await requireResourceAccess(
    request,
    'site',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  let body: {
    action?: unknown;
    repoUrl?: unknown;
    branch?: unknown;
    username?: unknown;
    token?: unknown;
    saveToken?: unknown;
    triggerBuild?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    body.action !== 'clone' &&
    body.action !== 'pull' &&
    body.action !== 'clearToken'
  ) {
    return NextResponse.json(
      { error: 'action must be clone, pull, or clearToken' },
      { status: 400 }
    );
  }

  if (body.action === 'clearToken') {
    try {
      const resp = await callControlAgent('site.git', {
        name: nameCheck.value,
        action: 'clearToken',
      });
      if (!resp.ok) {
        return NextResponse.json(
          { error: resp.stderr || 'Failed to remove saved token' },
          { status: 400 }
        );
      }
      const result = parseAgentJson<{ cleared: boolean }>(
        resp,
        'Invalid git clearToken response'
      );
      return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to remove token' },
        { status: 502 }
      );
    }
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

  let username: string | undefined;
  if (typeof body.username === 'string' && body.username.trim() !== '') {
    const cleanUser = body.username.trim();
    if (cleanUser.length > 128 || /[:\r\n\0]/.test(cleanUser)) {
      return NextResponse.json(
        { error: 'Invalid Git username' },
        { status: 400 }
      );
    }
    username = cleanUser;
  }

  let token: string | undefined;
  if (typeof body.token === 'string' && body.token.trim() !== '') {
    const cleanToken = body.token.trim();
    if (cleanToken.length > 512 || /[\r\n\0]/.test(cleanToken)) {
      return NextResponse.json(
        { error: 'Invalid personal access token format' },
        { status: 400 }
      );
    }
    if (repoUrl && !repoUrl.toLowerCase().startsWith('https://')) {
      return NextResponse.json(
        { error: 'Personal access tokens require an https:// repository URL' },
        { status: 400 }
      );
    }
    token = cleanToken;
  }

  try {
    const resp = await callControlAgent('site.git', {
      name: nameCheck.value,
      action: body.action,
      repoUrl,
      branch: branchCheck.value,
      username,
      token,
      saveToken: Boolean(body.saveToken),
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
      hasSavedToken?: boolean;
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

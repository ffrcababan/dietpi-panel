import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type SiteBuildRecord,
} from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import {
  SAFE_FILENAME_RE,
  validateRelativePath,
  validateResourceName,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink';
  size: number;
  mode?: string;
  modified: string;
}

export async function GET(
  request: Request,
  context: { params: { name: string } }
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const nameCheck = validateResourceName(context.params.name, 'site name');
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'list';
  const rawPath = url.searchParams.get('path') || '';

  const pathCheck = validateRelativePath(rawPath, mode === 'list');
  if (!pathCheck.ok) {
    return NextResponse.json({ error: pathCheck.error }, { status: 400 });
  }

  try {
    if (mode === 'read') {
      const resp = await callControlAgent('files.read', {
        name: nameCheck.value,
        path: pathCheck.value,
      });
      if (!resp.ok) {
        return NextResponse.json(
          { error: resp.stderr || 'Failed to read file' },
          { status: 400 }
        );
      }
      const file = parseAgentJson<{
        path: string;
        size: number;
        binary: boolean;
        content: string;
      }>(resp, 'Invalid file read response');
      return NextResponse.json({ file }, { headers: NO_STORE_HEADERS });
    }

    const resp = await callControlAgent('files.list', {
      name: nameCheck.value,
      path: pathCheck.value,
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: resp.stderr || 'Failed to list files' },
        { status: 400 }
      );
    }
    const listing = parseAgentJson<{
      siteRoot: string;
      path: string;
      entries: FileEntry[];
    }>(resp, 'Invalid file listing response');
    return NextResponse.json(listing, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'File operation failed' },
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
    op?: unknown;
    path?: unknown;
    fromPath?: unknown;
    toPath?: unknown;
    content?: unknown;
    dir?: unknown;
    filename?: unknown;
    contentBase64?: unknown;
    extractZip?: unknown;
    triggerBuild?: unknown;
    mode?: unknown;
    recursive?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const triggerBuild = body.triggerBuild !== false;

  try {
    switch (body.op) {
      case 'write': {
        const pathCheck = validateRelativePath(body.path, false);
        if (!pathCheck.ok) {
          return NextResponse.json({ error: pathCheck.error }, { status: 400 });
        }
        if (typeof body.content !== 'string') {
          return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
        }
        const resp = await callControlAgent('files.write', {
          name: nameCheck.value,
          path: pathCheck.value,
          content: body.content,
          triggerBuild,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to save file' },
            { status: 400 }
          );
        }
        const result = parseAgentJson<{
          path: string;
          size: number;
          build: SiteBuildRecord | null;
        }>(resp, 'Invalid file write response');
        return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
      }

      case 'upload': {
        const dirCheck = validateRelativePath(body.dir ?? '', true);
        if (!dirCheck.ok) {
          return NextResponse.json({ error: dirCheck.error }, { status: 400 });
        }
        const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
        if (!SAFE_FILENAME_RE.test(filename) || filename === '.' || filename === '..') {
          return NextResponse.json(
            { error: 'Invalid filename (use 1-128 chars: a-zA-Z0-9._-)' },
            { status: 400 }
          );
        }
        if (typeof body.contentBase64 !== 'string') {
          return NextResponse.json({ error: 'Invalid file payload' }, { status: 400 });
        }
        const resp = await callControlAgent('files.upload', {
          name: nameCheck.value,
          dir: dirCheck.value,
          filename,
          contentBase64: body.contentBase64,
          extractZip: Boolean(body.extractZip),
          triggerBuild,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Upload failed' },
            { status: 400 }
          );
        }
        const result = parseAgentJson<{
          path: string;
          bytes: number;
          extractedFiles: number;
          build: SiteBuildRecord | null;
        }>(resp, 'Invalid upload response');
        return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
      }

      case 'mkdir': {
        const pathCheck = validateRelativePath(body.path, false);
        if (!pathCheck.ok) {
          return NextResponse.json({ error: pathCheck.error }, { status: 400 });
        }
        const resp = await callControlAgent('files.mkdir', {
          name: nameCheck.value,
          path: pathCheck.value,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to create folder' },
            { status: 400 }
          );
        }
        return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
      }

      case 'rename': {
        const fromCheck = validateRelativePath(body.fromPath, false);
        const toCheck = validateRelativePath(body.toPath, false);
        if (!fromCheck.ok) {
          return NextResponse.json({ error: fromCheck.error }, { status: 400 });
        }
        if (!toCheck.ok) {
          return NextResponse.json({ error: toCheck.error }, { status: 400 });
        }
        const resp = await callControlAgent('files.rename', {
          name: nameCheck.value,
          fromPath: fromCheck.value,
          toPath: toCheck.value,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to rename' },
            { status: 400 }
          );
        }
        return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
      }

      case 'delete': {
        const pathCheck = validateRelativePath(body.path, false);
        if (!pathCheck.ok) {
          return NextResponse.json({ error: pathCheck.error }, { status: 400 });
        }
        const resp = await callControlAgent('files.delete', {
          name: nameCheck.value,
          path: pathCheck.value,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to delete' },
            { status: 400 }
          );
        }
        return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
      }

      case 'chmod': {
        const pathCheck = validateRelativePath(body.path, false);
        if (!pathCheck.ok) {
          return NextResponse.json({ error: pathCheck.error }, { status: 400 });
        }
        const rawMode = typeof body.mode === 'string' ? body.mode.trim() : '';
        if (!/^0?[0-7]{3}$/.test(rawMode)) {
          return NextResponse.json(
            { error: 'Mode must be a 3 or 4 digit octal permission (e.g. 0644, 0755, 0775)' },
            { status: 400 }
          );
        }
        const parsedMode = Number.parseInt(rawMode, 8);
        if ((parsedMode & 0o002) !== 0) {
          return NextResponse.json(
            {
              error:
                'World-writable modes (e.g. 777) are blocked for security; use 775 with www-data ownership',
            },
            { status: 400 }
          );
        }
        const resp = await callControlAgent('files.chmod', {
          name: nameCheck.value,
          path: pathCheck.value,
          mode: rawMode,
          recursive: Boolean(body.recursive),
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to update permissions' },
            { status: 400 }
          );
        }
        const result = parseAgentJson<{
          path: string;
          mode: string;
          recursive: boolean;
          updatedCount: number;
          type: string;
        }>(resp, 'Invalid chmod response');
        return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
      }

      case 'fixPermissions': {
        const resp = await callControlAgent('site.fixPermissions', {
          name: nameCheck.value,
        });
        if (!resp.ok) {
          return NextResponse.json(
            { error: resp.stderr || 'Failed to repair site permissions' },
            { status: 400 }
          );
        }
        const result = parseAgentJson<{
          type: string;
          dirsUpdated: number;
          filesUpdated: number;
          executablesFixed: number;
          writableDirs: string[];
        }>(resp, 'Invalid permissions repair response');
        return NextResponse.json({ result }, { headers: NO_STORE_HEADERS });
      }

      default:
        return NextResponse.json({ error: 'Unsupported file operation' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'File operation failed' },
      { status: 502 }
    );
  }
}

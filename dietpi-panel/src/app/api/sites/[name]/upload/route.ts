import { NextResponse } from 'next/server';
import {
  callControlAgent,
  parseAgentJson,
  type SiteBuildRecord,
} from '@/lib/agent';
import { requireResourceAccess } from '@/lib/auth';
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

const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BASE64_LEN = Math.ceil((MAX_CHUNK_BYTES * 4) / 3) + 16;

interface UploadStartResult {
  uploadId: string;
}

interface UploadChunkResult {
  bytesWritten: number;
}

interface UploadFinishResult {
  path: string;
  bytes: number;
  extractedFiles: number;
  build: SiteBuildRecord | null;
}

export async function POST(
  request: Request,
  context: { params: { name: string } }
) {
  const nameCheck = validateResourceName(context.params.name, 'site name');
  const auth = await requireResourceAccess(
    request,
    'site',
    nameCheck.ok ? nameCheck.value : ''
  );
  if (!auth.ok) return auth.response;

  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  const op = body.op;

  try {
    if (op === 'start') {
      const resp = await callControlAgent('files.uploadStart', {
        name: nameCheck.value,
      });
      const result = parseAgentJson<UploadStartResult>(
        resp,
        'Failed to start upload'
      );
      return NextResponse.json({ ok: true, result }, { headers: NO_STORE_HEADERS });
    }

    if (op === 'chunk') {
      const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
      if (!UPLOAD_ID_RE.test(uploadId)) {
        return NextResponse.json({ error: 'Invalid uploadId' }, { status: 400 });
      }

      const contentBase64 =
        typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
      if (!contentBase64 || contentBase64.length > MAX_CHUNK_BASE64_LEN) {
        return NextResponse.json(
          { error: 'Chunk must be non-empty and at most 4 MB' },
          { status: 400 }
        );
      }
      if (Buffer.from(contentBase64, 'base64').byteLength > MAX_CHUNK_BYTES) {
        return NextResponse.json(
          { error: 'Chunk decoded size exceeds 4 MB limit' },
          { status: 400 }
        );
      }

      const resp = await callControlAgent('files.uploadChunk', {
        name: nameCheck.value,
        uploadId,
        contentBase64,
      });
      const result = parseAgentJson<UploadChunkResult>(
        resp,
        'Failed to write upload chunk'
      );
      return NextResponse.json({ ok: true, result }, { headers: NO_STORE_HEADERS });
    }

    if (op === 'finish') {
      const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
      if (!UPLOAD_ID_RE.test(uploadId)) {
        return NextResponse.json({ error: 'Invalid uploadId' }, { status: 400 });
      }

      const dirCheck = validateRelativePath(body.dir ?? '', true);
      if (!dirCheck.ok) {
        return NextResponse.json({ error: dirCheck.error }, { status: 400 });
      }

      const filename =
        typeof body.filename === 'string' ? body.filename.trim() : '';
      if (
        !filename ||
        filename === '.' ||
        filename === '..' ||
        !SAFE_FILENAME_RE.test(filename)
      ) {
        return NextResponse.json(
          {
            error:
              'Filename must be 1-128 characters using letters, digits, dots, underscores, or hyphens',
          },
          { status: 400 }
        );
      }

      const resp = await callControlAgent('files.uploadFinish', {
        name: nameCheck.value,
        dir: dirCheck.value,
        uploadId,
        filename,
        extractZip: body.extractZip === true,
        triggerBuild: body.triggerBuild === true,
      });
      const result = parseAgentJson<UploadFinishResult>(
        resp,
        'Failed to finalize upload'
      );
      return NextResponse.json({ ok: true, result }, { headers: NO_STORE_HEADERS });
    }

    return NextResponse.json(
      { error: 'Unsupported upload operation' },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload operation failed' },
      { status: 502 }
    );
  }
}

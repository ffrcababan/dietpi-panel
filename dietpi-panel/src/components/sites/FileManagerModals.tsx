'use client';

import React, { useMemo, useState } from 'react';
import {
  IconCheck,
  IconFile,
  IconFolder,
  IconPlus,
  IconShield,
  IconTrash,
  IconUpload,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import type { FileEntry } from '@/app/api/sites/[name]/files/route';
import { SAFE_FILENAME_RE } from '@/lib/validation';

export const MAX_WEBAPP_UPLOAD_BYTES = 100 * 1024 * 1024;
const SAFE_UPLOAD_SEG_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const SKIP_UPLOAD_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.venv',
  '__pycache__',
]);
const SKIP_UPLOAD_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface QueuedUploadItem {
  file: File;
  dir: string;
  filename: string;
  targetPath: string;
}

export interface UploadPlan {
  validItems: QueuedUploadItem[];
  invalidPaths: string[];
  skippedFiltered: number;
  skippedDbPhp: number;
  totalBytes: number;
  isSingleZip: boolean;
  topFolderName: string;
}

export function buildUploadPlan(
  uploadFiles: File[],
  uploadMode: 'files' | 'folder',
  uploadToRoot: boolean,
  currentDir: string,
  stripTopFolder: boolean
): UploadPlan {
  const baseUploadDir = uploadToRoot ? '' : currentDir;
  const firstRelPath =
    (uploadFiles[0] as (File & { webkitRelativePath?: string }) | undefined)
      ?.webkitRelativePath || '';
  const topFolderName =
    uploadMode === 'folder' && firstRelPath.includes('/')
      ? firstRelPath.split('/')[0] || ''
      : '';

  const validItems: QueuedUploadItem[] = [];
  const invalidPaths: string[] = [];
  let skippedFiltered = 0;
  let skippedDbPhp = 0;
  let totalBytes = 0;

  for (const file of uploadFiles) {
    const relRaw = (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name
    ).replace(/\\/g, '/');
    let segments = relRaw.split('/').filter(Boolean);
    if (uploadMode === 'folder' && stripTopFolder && segments.length > 1) {
      segments = segments.slice(1);
    }
    if (segments.length === 0) continue;

    const filename = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);

    if (
      dirSegments.some((seg) => SKIP_UPLOAD_DIRS.has(seg)) ||
      SKIP_UPLOAD_FILES.has(filename)
    ) {
      skippedFiltered += 1;
      continue;
    }

    if (
      segments.some(
        (seg) => seg === '.' || seg === '..' || !SAFE_UPLOAD_SEG_RE.test(seg)
      )
    ) {
      invalidPaths.push(segments.join('/'));
      continue;
    }

    const combinedDirs = [baseUploadDir, ...dirSegments].filter(Boolean);
    const dir = combinedDirs.join('/');
    if (dir.length + 1 + filename.length > 512) {
      invalidPaths.push(segments.join('/'));
      continue;
    }

    if (dir === '' && filename === 'db.php') {
      skippedDbPhp += 1;
      continue;
    }

    const targetPath = dir ? `${dir}/${filename}` : filename;
    validItems.push({ file, dir, filename, targetPath });
    totalBytes += file.size;
  }

  const isSingleZip =
    validItems.length === 1 && validItems[0].filename.toLowerCase().endsWith('.zip');

  return {
    validItems,
    invalidPaths,
    skippedFiltered,
    skippedDbPhp,
    totalBytes,
    isSingleZip,
    topFolderName,
  };
}

export function NewFileModal({
  open,
  siteName,
  currentDir,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  siteName: string;
  currentDir: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (filename: string) => Promise<void>;
}) {
  const { me } = usePanel();
  const webUser = me?.webUser || 'www-data';
  const [name, setName] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName('');
      setErrMsg(null);
    }
  }, [open]);
  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    SAFE_FILENAME_RE.test(trimmed);

  const predictedMode =
    trimmed === '.env' ||
    (trimmed.startsWith('.env.') &&
      !['.env.example', '.env.sample', '.env.template', '.env.dist'].includes(trimmed))
      ? '0640'
      : trimmed === 'artisan' || trimmed.endsWith('.sh')
        ? '0755'
        : '0644';

  return (
    <Modal
      open={open}
      title="Create New File"
      subtitle={`Inside /var/www/${siteName}${currentDir ? `/${currentDir}` : ''}`}
      onClose={() => !busy && onClose()}
      badge={<IconFile className="w-4 h-4 text-accent" />}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setErrMsg(null);
          try {
            await onCreate(trimmed);
          } catch (err) {
            setErrMsg(err instanceof Error ? err.message : 'Failed to create file');
          }
        }}
        className="space-y-4"
      >
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Filename
          </label>
          <input
            type="text"
            autoFocus
            required
            disabled={busy}
            placeholder="e.g. .env or index.html"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
          />
          {trimmed && !valid && (
            <p className="mt-1 text-[11px] text-rose-400">
              Use 1-128 safe characters (letters, digits, dot, underscore, hyphen).
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] text-slate-400">Quick filenames</div>
          <div className="flex flex-wrap gap-1.5">
            {['.env', 'index.php', 'index.html', 'package.json', 'deploy.sh'].map(
              (preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setName(preset)}
                  className="rounded-md border border-borderline bg-canvas px-2 py-1 font-mono text-[11px] text-slate-300 hover:border-accent/50 hover:text-slate-100 transition"
                >
                  {preset}
                </button>
              )
            )}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-borderline bg-canvas px-3 py-2 text-[11px] font-mono text-slate-400">
          <span className="truncate">
            /{currentDir ? `${currentDir}/` : ''}
            {trimmed || '<file>'}
          </span>
          <span className="shrink-0 text-slate-300">mode {predictedMode} · {webUser}</span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Creating...' : 'Create & Edit'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewFolderModal({
  open,
  siteName,
  currentDir,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  siteName: string;
  currentDir: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (folderName: string) => Promise<void>;
}) {
  const { me } = usePanel();
  const webUser = me?.webUser || 'www-data';
  const [name, setName] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName('');
      setErrMsg(null);
    }
  }, [open]);
  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    SAFE_FILENAME_RE.test(trimmed);

  return (
    <Modal
      open={open}
      title="Create Folder"
      subtitle={`Inside /var/www/${siteName}${currentDir ? `/${currentDir}` : ''}`}
      onClose={() => !busy && onClose()}
      badge={<IconFolder className="w-4 h-4 text-sky-400" />}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setErrMsg(null);
          try {
            await onCreate(trimmed);
          } catch (err) {
            setErrMsg(err instanceof Error ? err.message : 'Failed to create folder');
          }
        }}
        className="space-y-4"
      >
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Folder Name
          </label>
          <input
            type="text"
            autoFocus
            required
            disabled={busy}
            placeholder="e.g. src or public"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
          />
          {trimmed && !valid && (
            <p className="mt-1 text-[11px] text-rose-400">
              Use 1-128 safe characters (letters, digits, dot, underscore, hyphen).
            </p>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-borderline bg-canvas px-3 py-2 text-[11px] font-mono text-slate-400">
          <span className="truncate">
            /{currentDir ? `${currentDir}/` : ''}
            {trimmed || '<folder>'}
          </span>
          <span className="shrink-0 text-slate-300">owner {webUser} · 0755</span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Creating...' : 'Create Folder'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function UploadWebAppModal({
  open,
  siteName,
  siteType,
  currentDir,
  uploadMode,
  uploadFiles,
  uploadToRoot,
  stripTopFolder,
  extractZip,
  uploadAutoBuild,
  uploading,
  uploadProgress,
  uploadError,
  onClose,
  onChangeMode,
  onChangeFiles,
  onChangeToRoot,
  onChangeStripTop,
  onChangeExtractZip,
  onChangeAutoBuild,
  onSubmit,
}: {
  open: boolean;
  siteName: string;
  siteType: string;
  currentDir: string;
  uploadMode: 'files' | 'folder';
  uploadFiles: File[];
  uploadToRoot: boolean;
  stripTopFolder: boolean;
  extractZip: boolean;
  uploadAutoBuild: boolean;
  uploading: boolean;
  uploadProgress: { percent: number; label: string } | null;
  uploadError?: string | null;
  onClose: () => void;
  onChangeMode: (mode: 'files' | 'folder') => void;
  onChangeFiles: (files: File[]) => void;
  onChangeToRoot: (toRoot: boolean) => void;
  onChangeStripTop: (strip: boolean) => void;
  onChangeExtractZip: (extract: boolean) => void;
  onChangeAutoBuild: (autoBuild: boolean) => void;
  onSubmit: (e: React.FormEvent, plan: UploadPlan) => Promise<void>;
}) {
  const { me } = usePanel();
  const webUser = me?.webUser || 'www-data';
  const [dragActive, setDragActive] = useState(false);

  const uploadPlan = useMemo(
    () =>
      buildUploadPlan(
        uploadFiles,
        uploadMode,
        uploadToRoot,
        currentDir,
        stripTopFolder
      ),
    [uploadFiles, uploadMode, uploadToRoot, currentDir, stripTopFolder]
  );

  return (
    <Modal
      open={open}
      title="Upload Finished Web App"
      subtitle="Upload a .zip archive, multiple files, or a built folder up to 100 MB (chunked). Symlinks are blocked and /db.php is protected."
      onClose={() => !uploading && onClose()}
      maxWidthClass="max-w-xl"
      badge={<IconUpload className="w-4 h-4 text-accent" />}
    >
      <form
        onSubmit={(e) => void onSubmit(e, uploadPlan)}
        className="space-y-4"
      >
        {uploadError && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {uploadError}
          </div>
        )}
        {/* Destination selector */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Destination
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => onChangeToRoot(true)}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                uploadToRoot
                  ? 'border-accent/60 bg-accent/15 text-slate-100'
                  : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
              }`}
            >
              <div className="font-semibold">Site Root</div>
              <div className="truncate font-mono text-[10px] text-slate-400">
                /var/www/{siteName}/
              </div>
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={() => onChangeToRoot(false)}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                !uploadToRoot
                  ? 'border-accent/60 bg-accent/15 text-slate-100'
                  : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
              }`}
            >
              <div className="font-semibold">Current Folder</div>
              <div className="truncate font-mono text-[10px] text-slate-400">
                /{currentDir || ''}
              </div>
            </button>
          </div>
        </div>

        {/* Mode tabs */}
        <div className="flex rounded-lg border border-borderline bg-canvas p-1 gap-1">
          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              onChangeMode('files');
              onChangeFiles([]);
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              uploadMode === 'files'
                ? 'bg-elevated text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            .zip Archive / Files
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => {
              onChangeMode('folder');
              onChangeFiles([]);
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              uploadMode === 'folder'
                ? 'bg-elevated text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Project / Dist Folder
          </button>
        </div>

        {/* Dropzone / Picker */}
        <label
          onDragOver={(e) => {
            if (uploadMode !== 'files' || uploading) return;
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            if (uploadMode !== 'files' || uploading) return;
            e.preventDefault();
            setDragActive(false);
            const dropped = Array.from(e.dataTransfer?.files || []);
            if (dropped.length > 0) onChangeFiles(dropped);
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition ${
            uploading
              ? 'cursor-not-allowed border-borderline bg-canvas/50 opacity-60'
              : dragActive
                ? 'cursor-pointer border-accent bg-accent/10'
                : 'cursor-pointer border-borderline bg-canvas hover:border-slate-500'
          }`}
        >
          {uploadMode === 'files' ? (
            <input
              type="file"
              multiple
              disabled={uploading}
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                if (picked.length > 0) onChangeFiles(picked);
                e.currentTarget.value = '';
              }}
              className="sr-only"
            />
          ) : (
            <input
              type="file"
              multiple
              disabled={uploading}
              {...({
                webkitdirectory: '',
                directory: '',
              } as Record<string, string>)}
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                if (picked.length > 0) onChangeFiles(picked);
                e.currentTarget.value = '';
              }}
              className="sr-only"
            />
          )}
          <IconUpload className="w-5 h-5 text-accent" />
          <div className="text-xs font-medium text-slate-200">
            {uploadMode === 'files'
              ? 'Click to select a .zip archive or files, or drag & drop here'
              : 'Click to select your built folder (dist/, build/, out/, or project root)'}
          </div>
          <div className="text-[11px] text-slate-400">
            {uploadMode === 'files'
              ? 'Files over 1.5 MB stream automatically in 2 MB chunks (max 100 MB)'
              : 'Preserves subfolder tree; automatically skips .git and node_modules'}
          </div>
        </label>

        {/* Queue summary */}
        {uploadFiles.length > 0 && (
          <div className="rounded-xl border border-borderline bg-canvas p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between text-slate-200">
              <span className="font-semibold">
                Ready: {uploadPlan.validItems.length} file(s) (
                {(uploadPlan.totalBytes / (1024 * 1024)).toFixed(2)} MB)
              </span>
              {!uploading && (
                <button
                  type="button"
                  onClick={() => onChangeFiles([])}
                  className="text-[11px] text-slate-400 hover:text-slate-200"
                >
                  Clear
                </button>
              )}
            </div>

            {uploadPlan.validItems.length > 0 && (
              <div className="max-h-24 overflow-y-auto space-y-0.5 font-mono text-[11px] text-slate-400">
                {uploadPlan.validItems.slice(0, 5).map((item) => (
                  <div key={item.targetPath} className="truncate">
                    -&gt; /{item.targetPath}
                  </div>
                ))}
                {uploadPlan.validItems.length > 5 && (
                  <div className="text-slate-500">
                    ...and {uploadPlan.validItems.length - 5} more file(s)
                  </div>
                )}
              </div>
            )}

            {(uploadPlan.skippedFiltered > 0 || uploadPlan.skippedDbPhp > 0) && (
              <div className="text-[11px] text-slate-400">
                Auto-skipped {uploadPlan.skippedFiltered} build/VCS file(s)
                {uploadPlan.skippedDbPhp > 0 ? ' and protected /db.php' : ''}.
              </div>
            )}

            {uploadPlan.invalidPaths.length > 0 && (
              <div className="text-[11px] text-amber-300">
                {uploadPlan.invalidPaths.length} file(s) contain unsupported spaces or special characters (e.g.{' '}
                <span className="font-mono">{uploadPlan.invalidPaths[0]}</span>). Rename or bundle inside a .zip.
              </div>
            )}

            {uploadPlan.totalBytes > MAX_WEBAPP_UPLOAD_BYTES && (
              <div className="text-[11px] text-rose-400">
                Total size exceeds the 100 MB limit. Remove unused assets or split uploads.
              </div>
            )}
          </div>
        )}

        {/* Options */}
        <div className="space-y-2">
          {uploadMode === 'folder' && uploadPlan.topFolderName && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={uploading}
                checked={stripTopFolder}
                onChange={(e) => onChangeStripTop(e.target.checked)}
                className="rounded border-borderline bg-canvas text-accent"
              />
              <span>
                Upload contents directly (strip top folder{' '}
                <span className="font-mono text-slate-200">
                  {uploadPlan.topFolderName}/
                </span>
                )
              </span>
            </label>
          )}

          {uploadPlan.isSingleZip && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={uploading}
                checked={extractZip}
                onChange={(e) => onChangeExtractZip(e.target.checked)}
                className="rounded border-borderline bg-canvas text-accent"
              />
              <span>Extract .zip contents into destination folder</span>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              disabled={uploading}
              checked={uploadAutoBuild}
              onChange={(e) => onChangeAutoBuild(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent"
            />
            <span>Automatically run {siteType} build pipeline after upload</span>
          </label>
        </div>

        <div className="rounded-lg border border-borderline bg-canvas/70 px-3 py-2 text-[11px] text-slate-400">
          <span className="font-medium text-slate-300">Auto-Permissions:</span>{' '}
          <span className="font-mono text-slate-200">{webUser}</span> owner · Folders{' '}
          <span className="font-mono text-slate-200">0755</span> · Files{' '}
          <span className="font-mono text-slate-200">0644</span> ·{' '}
          <span className="font-mono text-amber-300">.env* 0640</span> · Binaries{' '}
          <span className="font-mono text-sky-300">0755</span>
          {siteType === 'laravel' && (
            <>
              {' '}
              · Laravel <span className="font-mono text-emerald-300">storage/</span> &amp;{' '}
              <span className="font-mono text-emerald-300">bootstrap/cache/ 0775</span>
            </>
          )}
        </div>

        {uploading && uploadProgress && (
          <div className="space-y-1.5 rounded-lg border border-borderline bg-canvas p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-300">
              <span className="truncate pr-2">{uploadProgress.label}</span>
              <span className="font-mono text-accent shrink-0">
                {uploadProgress.percent}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              uploading ||
              uploadPlan.validItems.length === 0 ||
              uploadPlan.invalidPaths.length > 0 ||
              uploadPlan.totalBytes > MAX_WEBAPP_UPLOAD_BYTES
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>
              {uploading
                ? `Uploading (${uploadProgress?.percent ?? 0}%)...`
                : uploadPlan.isSingleZip && extractZip
                  ? 'Upload & Extract'
                  : uploadPlan.validItems.length > 1
                    ? `Upload ${uploadPlan.validItems.length} Files`
                    : 'Upload'}
            </span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function describeOctalMode(modeStr: string): string {
  const clean = modeStr.replace(/^0+/, '').padStart(3, '0');
  if (!/^[0-7]{3}$/.test(clean)) return 'Enter 3 or 4 octal digits (e.g. 0755)';
  const perms = (d: string) => {
    const n = Number.parseInt(d, 8);
    return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  };
  return `Owner ${perms(clean[0])} · Group ${perms(clean[1])} · Other ${perms(clean[2])}`;
}

export function PermissionsModal({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  target: FileEntry | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (mode: string, recursive: boolean) => Promise<void>;
}) {
  const { me } = usePanel();
  const webUser = me?.webUser || 'www-data';
  const [mode, setMode] = useState(target?.mode || '0644');
  const [recursive, setRecursive] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  React.useEffect(() => {
    if (target) {
      setMode(target.mode || (target.type === 'dir' ? '0755' : '0644'));
      setRecursive(false);
      setErrMsg(null);
    }
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      title="File & Folder Permissions"
      subtitle={`All site files remain owned by ${webUser}:${webUser}. Use 0775 (never 0777) for writable directories like Laravel storage/.`}
      onClose={() => !busy && onClose()}
      badge={<IconShield className="w-4 h-4 text-emerald-400" />}
    >
      {target && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setErrMsg(null);
            try {
              await onSubmit(mode.trim(), recursive);
            } catch (err) {
              setErrMsg(
                err instanceof Error ? err.message : 'Failed to update permissions'
              );
            }
          }}
          className="space-y-4"
        >
          {errMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {errMsg}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-200">
            <span className="truncate">/{target.path}</span>
            <span className="shrink-0 text-slate-400">{target.type}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {[
              { mode: '0644', label: '0644 · Standard File', desc: 'rw-r--r--' },
              { mode: '0755', label: '0755 · Folder / Script', desc: 'rwxr-xr-x' },
              { mode: '0775', label: '0775 · Writable Dir', desc: 'Laravel storage / cache' },
              { mode: '0640', label: '0640 · .env Secret', desc: 'rw-r-----' },
            ].map((opt) => (
              <button
                key={opt.mode}
                type="button"
                disabled={busy}
                onClick={() => setMode(opt.mode)}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  mode === opt.mode
                    ? 'border-accent/60 bg-accent/15 text-slate-100'
                    : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
                }`}
              >
                <div className="font-mono font-medium text-slate-200">{opt.label}</div>
                <div className="text-[10px] text-slate-500">{opt.desc}</div>
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Octal Mode
            </label>
            <input
              type="text"
              required
              disabled={busy}
              pattern="^0?[0-7]{3}$"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
            />
            <div className="mt-1 font-mono text-[11px] text-slate-400">
              {describeOctalMode(mode)}
            </div>
          </div>

          {target.type === 'dir' && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={busy}
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="rounded border-borderline bg-canvas text-accent"
              />
              <span>Apply recursively to all subfolders and files</span>
            </label>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
            >
              {busy ? 'Applying...' : 'Apply Permissions'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function RenameModal({
  target,
  onClose,
  onRename,
}: {
  target: FileEntry | null;
  onClose: () => void;
  onRename: (newPath: string) => Promise<void>;
}) {
  const [value, setValue] = useState(target?.path || '');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  React.useEffect(() => {
    if (target) {
      setValue(target.path);
      setErrMsg(null);
    }
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      title="Rename / Move"
      subtitle="Move or rename within the site workspace."
      onClose={() => !busy && onClose()}
    >
      {target && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!value.trim() || busy) return;
            setBusy(true);
            setErrMsg(null);
            try {
              await onRename(value.trim());
            } catch (err) {
              setErrMsg(err instanceof Error ? err.message : 'Rename failed');
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          {errMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {errMsg}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Target Relative Path
            </label>
            <input
              type="text"
              autoFocus
              required
              disabled={busy}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !value.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
            >
              {busy ? 'Moving...' : 'Save Name'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function DeletePathModal({
  target,
  onClose,
  onDelete,
}: {
  target: FileEntry | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  React.useEffect(() => {
    if (target) setErrMsg(null);
  }, [target]);

  return (
    <Modal
      open={Boolean(target)}
      title="Delete Path"
      subtitle="This permanently deletes the selected file or directory from disk."
      onClose={() => !busy && onClose()}
      badge={<IconTrash className="w-4 h-4 text-rose-400" />}
    >
      {target && (
        <div className="space-y-4">
          {errMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {errMsg}
            </div>
          )}
          <p className="text-xs text-slate-300 leading-relaxed">
            Permanently delete{' '}
            <span className="font-mono font-semibold text-rose-300">
              /{target.path}
            </span>{' '}
            ({target.type})?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErrMsg(null);
                try {
                  await onDelete();
                } catch (err) {
                  setErrMsg(err instanceof Error ? err.message : 'Delete failed');
                } finally {
                  setBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            >
              <IconCheck className="w-3.5 h-3.5" />
              <span>{busy ? 'Deleting...' : 'Delete Permanently'}</span>
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

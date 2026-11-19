'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconCheck,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import type { SiteBuildRecord } from '@/lib/agent';
import { formatBytes, formatDateTime } from '@/lib/format';
import { FRAMEWORK_PRESETS, type SiteType } from '@/lib/validation';
import type { SiteBuildStatusResponse } from '@/app/api/sites/[name]/build/route';
import type { FileEntry } from '@/app/api/sites/[name]/files/route';
import type { GitStatus } from '@/app/api/sites/[name]/git/route';

export default function SiteWorkspacePage({
  params,
}: {
  params: { name: string };
}) {
  const siteName = decodeURIComponent(params.name);
  const { me } = usePanel();

  const [tab, setTab] = useState<'files' | 'deploy'>('files');
  const [currentDir, setCurrentDir] = useState('');
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Editor state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [fileBinary, setFileBinary] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);

  // Modals
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<'files' | 'folder'>('files');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadToRoot, setUploadToRoot] = useState(true);
  const [stripTopFolder, setStripTopFolder] = useState(true);
  const [extractZip, setExtractZip] = useState(true);
  const [uploadAutoBuild, setUploadAutoBuild] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);

  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [permsTarget, setPermsTarget] = useState<FileEntry | null>(null);
  const [permsMode, setPermsMode] = useState('0644');
  const [permsRecursive, setPermsRecursive] = useState(false);
  const [permsBusy, setPermsBusy] = useState(false);
  const [fixingPerms, setFixingPerms] = useState(false);

  // Git & Build state
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [gitAutoBuild, setGitAutoBuild] = useState(true);
  const [gitBusy, setGitBusy] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);

  const {
    data: listing,
    error: listError,
    mutate: mutateFiles,
  } = useSWR<{ siteRoot: string; path: string; entries: FileEntry[] }>(
    `/api/sites/${encodeURIComponent(siteName)}/files?path=${encodeURIComponent(currentDir)}`,
    apiFetcher
  );

  const { data: buildStatus, mutate: mutateBuild } =
    useSWR<SiteBuildStatusResponse>(
      `/api/sites/${encodeURIComponent(siteName)}/build`,
      apiFetcher,
      { refreshInterval: 3000 }
    );

  const { data: gitData, mutate: mutateGit } = useSWR<{ git: GitStatus }>(
    `/api/sites/${encodeURIComponent(siteName)}/git`,
    apiFetcher
  );

  const siteType = (buildStatus?.type || 'custom') as SiteType;
  const preset = FRAMEWORK_PRESETS[siteType] ?? null;
  const entries = listing?.entries ?? [];
  const hasUnsaved = selectedFile !== null && !fileBinary && fileContent !== savedContent;

  const openFile = async (relPath: string) => {
    setLoadingFile(true);
    setBanner(null);
    try {
      const res = await apiFetcher<{
        file: { path: string; size: number; binary: boolean; content: string };
      }>(
        `/api/sites/${encodeURIComponent(siteName)}/files?mode=read&path=${encodeURIComponent(relPath)}`
      );
      setSelectedFile(res.file.path);
      setFileBinary(res.file.binary);
      setFileContent(res.file.content);
      setSavedContent(res.file.content);
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to open file',
      });
    } finally {
      setLoadingFile(false);
    }
  };

  const saveFile = async (triggerBuild: boolean) => {
    if (!me?.csrfToken || !selectedFile || fileBinary) return;
    setSavingFile(true);
    setBanner(null);
    try {
      const res = await apiMutate<{
        result: { path: string; size: number; build: SiteBuildRecord | null };
      }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
        op: 'write',
        path: selectedFile,
        content: fileContent,
        triggerBuild,
      });
      setSavedContent(fileContent);
      const b = res.result.build;
      if (b) {
        setBanner({
          ok: b.queued ? true : b.ok,
          text: b.queued
            ? `Saved ${selectedFile} — build queued.`
            : b.ok
              ? `Saved ${selectedFile} and completed ${b.type} build pipeline.`
              : `Saved ${selectedFile}, but build failed (see Build Logs).`,
        });
      } else {
        setBanner({ ok: true, text: `Saved ${selectedFile}.` });
      }
      await Promise.all([mutateFiles(), mutateBuild()]);
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to save file',
      });
    } finally {
      setSavingFile(false);
    }
  };

  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !newFileName.trim()) return;
    const rel = currentDir ? `${currentDir}/${newFileName.trim()}` : newFileName.trim();
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        { op: 'write', path: rel, content: '', triggerBuild: false }
      );
      setNewFileOpen(false);
      setNewFileName('');
      await mutateFiles();
      await openFile(rel);
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to create file',
      });
    }
  };

  const handleCreateDir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !newDirName.trim()) return;
    const rel = currentDir ? `${currentDir}/${newDirName.trim()}` : newDirName.trim();
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        { op: 'mkdir', path: rel }
      );
      setNewDirOpen(false);
      setNewDirName('');
      await mutateFiles();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to create folder',
      });
    }
  };

  const openUploadModal = (toRoot: boolean) => {
    setUploadToRoot(toRoot);
    setUploadMode('files');
    setUploadFiles([]);
    setUploadProgress(null);
    setDragActive(false);
    setUploadOpen(true);
  };

  const MAX_WEBAPP_UPLOAD_BYTES = 100 * 1024 * 1024;
  const CHUNK_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024);
  const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;
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

  interface QueuedUploadItem {
    file: File;
    dir: string;
    filename: string;
    targetPath: string;
  }

  const baseUploadDir = uploadToRoot ? '' : currentDir;
  const firstRelPath =
    (uploadFiles[0] as (File & { webkitRelativePath?: string }) | undefined)
      ?.webkitRelativePath || '';
  const topFolderName =
    uploadMode === 'folder' && firstRelPath.includes('/')
      ? firstRelPath.split('/')[0] || ''
      : '';

  const uploadPlan = (() => {
    const validItems: QueuedUploadItem[] = [];
    const invalidPaths: string[] = [];
    let skippedFiltered = 0;
    let skippedDbPhp = 0;
    let totalBytes = 0;

    for (const file of uploadFiles) {
      const relRaw =
        (
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
      validItems.length === 1 &&
      validItems[0].filename.toLowerCase().endsWith('.zip');

    return {
      validItems,
      invalidPaths,
      skippedFiltered,
      skippedDbPhp,
      totalBytes,
      isSingleZip,
    };
  })();

  const uint8ToBase64 = (bytes: Uint8Array): string => {
    const sliceSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += sliceSize) {
      const sub = bytes.subarray(i, i + sliceSize);
      binary += String.fromCharCode(...Array.from(sub));
    }
    return btoa(binary);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || uploadPlan.validItems.length === 0) return;

    if (uploadPlan.invalidPaths.length > 0) {
      setBanner({
        ok: false,
        text: `Unsupported characters in filename/path (e.g. spaces): ${uploadPlan.invalidPaths[0]}. Rename or package inside a clean .zip.`,
      });
      return;
    }

    if (uploadPlan.totalBytes > MAX_WEBAPP_UPLOAD_BYTES) {
      setBanner({
        ok: false,
        text: 'Total upload size exceeds the 100 MB limit.',
      });
      return;
    }

    setUploading(true);
    setBanner(null);
    const totalBytes = Math.max(1, uploadPlan.totalBytes);
    let completedBytes = 0;

    try {
      const items = uploadPlan.validItems;
      const singleMode = items.length === 1;
      let lastExtractedFiles = 0;
      let finalBuild: SiteBuildRecord | null = null;

      for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx];
        const shouldExtract = uploadPlan.isSingleZip && extractZip;
        const inlineBuild = singleMode && uploadAutoBuild;
        const stepPrefix = singleMode
          ? item.filename
          : `[${idx + 1}/${items.length}] ${item.targetPath}`;

        setUploadProgress({
          percent: Math.min(99, Math.round((completedBytes / totalBytes) * 100)),
          label: `Uploading ${stepPrefix}...`,
        });

        if (item.file.size > CHUNK_THRESHOLD_BYTES) {
          const startRes = await apiMutate<{
            ok: boolean;
            result: { uploadId: string };
          }>(`/api/sites/${encodeURIComponent(siteName)}/upload`, 'POST', me.csrfToken, {
            op: 'start',
          });
          const uploadId = startRes.result.uploadId;

          let offset = 0;
          while (offset < item.file.size) {
            const end = Math.min(item.file.size, offset + CHUNK_SIZE_BYTES);
            const buf = await item.file.slice(offset, end).arrayBuffer();
            const contentBase64 = uint8ToBase64(new Uint8Array(buf));

            await apiMutate<{
              ok: boolean;
              result: { bytesWritten: number };
            }>(`/api/sites/${encodeURIComponent(siteName)}/upload`, 'POST', me.csrfToken, {
              op: 'chunk',
              uploadId,
              contentBase64,
            });

            offset = end;
            setUploadProgress({
              percent: Math.min(
                99,
                Math.round(((completedBytes + offset) / totalBytes) * 100)
              ),
              label: `Uploading ${stepPrefix} (${Math.round((offset / (1024 * 1024)) * 10) / 10} / ${Math.round((item.file.size / (1024 * 1024)) * 10) / 10} MB)`,
            });
          }

          if (shouldExtract) {
            setUploadProgress({
              percent: 99,
              label: `Extracting ${item.filename}${inlineBuild ? ' and running build' : ''}...`,
            });
          }

          const finishRes = await apiMutate<{
            ok: boolean;
            result: {
              path: string;
              bytes: number;
              extractedFiles: number;
              build: SiteBuildRecord | null;
            };
          }>(`/api/sites/${encodeURIComponent(siteName)}/upload`, 'POST', me.csrfToken, {
            op: 'finish',
            uploadId,
            dir: item.dir,
            filename: item.filename,
            extractZip: shouldExtract,
            triggerBuild: inlineBuild,
          });
          lastExtractedFiles = finishRes.result.extractedFiles;
          if (finishRes.result.build) finalBuild = finishRes.result.build;
        } else {
          const buf = await item.file.arrayBuffer();
          const contentBase64 = uint8ToBase64(new Uint8Array(buf));
          const res = await apiMutate<{
            result: {
              path: string;
              bytes: number;
              extractedFiles: number;
              build: SiteBuildRecord | null;
            };
          }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
            op: 'upload',
            dir: item.dir,
            filename: item.filename,
            contentBase64,
            extractZip: shouldExtract,
            triggerBuild: inlineBuild,
          });
          lastExtractedFiles = res.result.extractedFiles;
          if (res.result.build) finalBuild = res.result.build;
        }

        completedBytes += item.file.size;
      }

      if (!singleMode && !uploadAutoBuild) {
        setUploadProgress({
          percent: 98,
          label: `Applying ${siteType} file & folder permissions...`,
        });
        await apiMutate(
          `/api/sites/${encodeURIComponent(siteName)}/files`,
          'POST',
          me.csrfToken,
          { op: 'fixPermissions' }
        );
      }

      if (!singleMode && uploadAutoBuild) {
        setUploadProgress({
          percent: 99,
          label: `Running ${siteType} build pipeline...`,
        });
        const buildRes = await apiMutate<{
          ok: boolean;
          build: SiteBuildRecord | null;
        }>(`/api/sites/${encodeURIComponent(siteName)}/build`, 'POST', me.csrfToken, {});
        finalBuild = buildRes.build;
      }

      setUploadProgress({ percent: 100, label: 'Done' });
      setUploadOpen(false);
      setUploadFiles([]);
      setUploadProgress(null);

      const summaryText = singleMode
        ? lastExtractedFiles > 0
          ? `Extracted ${lastExtractedFiles} file(s)`
          : `Uploaded ${items[0].targetPath}`
        : `Uploaded ${items.length} file(s)`;

      setBanner({
        ok: finalBuild ? finalBuild.ok : true,
        text: `${summaryText}${finalBuild ? ` · build ${finalBuild.ok ? 'succeeded' : 'failed'}` : ''}.`,
      });
      await Promise.all([mutateFiles(), mutateBuild()]);
    } catch (err) {
      await Promise.all([mutateFiles(), mutateBuild()]);
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Upload failed',
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !renameTarget || !renameValue.trim()) return;
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        {
          op: 'rename',
          fromPath: renameTarget.path,
          toPath: renameValue.trim(),
        }
      );
      if (selectedFile === renameTarget.path) {
        setSelectedFile(renameValue.trim());
      }
      setRenameTarget(null);
      await mutateFiles();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Rename failed',
      });
    }
  };

  const handleDelete = async () => {
    if (!me?.csrfToken || !deleteTarget) return;
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        { op: 'delete', path: deleteTarget.path }
      );
      if (selectedFile === deleteTarget.path) {
        setSelectedFile(null);
        setFileContent('');
        setSavedContent('');
      }
      setDeleteTarget(null);
      await mutateFiles();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  };

  const handleFixPermissions = async () => {
    if (!me?.csrfToken || fixingPerms) return;
    setFixingPerms(true);
    setBanner(null);
    try {
      const res = await apiMutate<{
        result: {
          type: string;
          dirsUpdated: number;
          filesUpdated: number;
          executablesFixed: number;
          writableDirs: string[];
        };
      }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
        op: 'fixPermissions',
      });
      const r = res.result;
      setBanner({
        ok: true,
        text: `Applied www-data ownership & ${r.type} permissions (dirs updated: ${r.dirsUpdated}, files updated: ${r.filesUpdated}${
          r.executablesFixed ? `, +x binaries: ${r.executablesFixed}` : ''
        }${r.writableDirs.length ? `, writable 0775: ${r.writableDirs.join(', ')}` : ''}).`,
      });
      await mutateFiles();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to fix permissions',
      });
    } finally {
      setFixingPerms(false);
    }
  };

  const handleChmod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !permsTarget || permsBusy) return;
    setPermsBusy(true);
    setBanner(null);
    try {
      const res = await apiMutate<{
        result: {
          path: string;
          mode: string;
          recursive: boolean;
          updatedCount: number;
        };
      }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
        op: 'chmod',
        path: permsTarget.path,
        mode: permsMode.trim(),
        recursive: permsTarget.type === 'dir' && permsRecursive,
      });
      setPermsTarget(null);
      setBanner({
        ok: true,
        text: `Updated ${res.result.path} to ${res.result.mode} (${res.result.updatedCount} item(s), owner www-data).`,
      });
      await mutateFiles();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update permissions',
      });
    } finally {
      setPermsBusy(false);
    }
  };

  const handleRunBuild = async () => {
    if (!me?.csrfToken || buildBusy) return;
    setBuildBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteName)}/build`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-panel-csrf': me.csrfToken,
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        build?: SiteBuildRecord;
        error?: string;
      };
      setBanner({
        ok: res.ok && Boolean(json.ok),
        text:
          res.ok && json.ok
            ? `Build pipeline completed for ${siteName}.`
            : json.error || 'Build pipeline failed — see step output below.',
      });
      setTab('deploy');
      await mutateBuild();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to run build',
      });
    } finally {
      setBuildBusy(false);
    }
  };

  const handleToggleWatch = async () => {
    if (!me?.csrfToken || watchBusy) return;
    setWatchBusy(true);
    try {
      const next = !Boolean(buildStatus?.watch);
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/watch`,
        'POST',
        me.csrfToken,
        { enabled: next }
      );
      setBanner({
        ok: true,
        text: next
          ? 'Auto-watcher enabled: external SSH/SFTP edits will automatically run the preset build.'
          : 'Auto-watcher disabled.',
      });
      await mutateBuild();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to toggle watcher',
      });
    } finally {
      setWatchBusy(false);
    }
  };

  const handleGitAction = async (action: 'clone' | 'pull') => {
    if (!me?.csrfToken || gitBusy) return;
    setGitBusy(true);
    setBanner(null);
    try {
      const res = await apiMutate<{
        result: { build?: SiteBuildRecord | null };
      }>(`/api/sites/${encodeURIComponent(siteName)}/git`, 'POST', me.csrfToken, {
        action,
        repoUrl: action === 'clone' ? repoUrl.trim() : undefined,
        branch: branch.trim() || undefined,
        triggerBuild: gitAutoBuild,
      });
      const b = res.result.build;
      setBanner({
        ok: b ? b.ok : true,
        text: `Git ${action} completed${b ? ` · build ${b.ok ? 'succeeded' : 'failed'}` : ''}.`,
      });
      await Promise.all([mutateGit(), mutateFiles(), mutateBuild()]);
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : `Git ${action} failed`,
      });
    } finally {
      setGitBusy(false);
    }
  };

  const breadcrumbs = currentDir ? currentDir.split('/').filter(Boolean) : [];
  const lastBuild = buildStatus?.lastBuild;
  const git = gitData?.git;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link href="/sites" className="hover:text-accent transition">
              Sites
            </Link>
            <span>/</span>
            <span className="font-mono text-slate-200">{siteName}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight font-mono text-slate-100">
              {siteName}
            </h1>
            <StatusBadge tone="blue" label={preset?.label || siteType} />
            {buildStatus?.building && <StatusBadge tone="amber" label="Building..." dot />}
          </div>
          <p className="mt-1 text-xs font-mono text-slate-400">
            /var/www/{siteName}
            {preset ? ` · Auto-build: ${preset.pipeline}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openUploadModal(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-accent/50 bg-accent/15 px-3.5 py-2 text-xs font-semibold text-accent hover:bg-accent/25 transition"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Upload Web App</span>
          </button>

          <button
            type="button"
            disabled={fixingPerms}
            onClick={handleFixPermissions}
            className="inline-flex items-center gap-2 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50 transition"
            title="Apply www-data ownership and recommended framework file/folder permissions (755/644, +x binaries, Laravel 775 storage)"
          >
            <svg
              className="w-3.5 h-3.5 text-emerald-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <polyline points="9 12 11 14 15 10" />
            </svg>
            <span>{fixingPerms ? 'Fixing Perms...' : 'Fix Permissions'}</span>
          </button>

          <button
            type="button"
            disabled={watchBusy}
            onClick={handleToggleWatch}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition ${
              buildStatus?.watch
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                : 'border-borderline bg-surface text-slate-300 hover:border-slate-500'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                buildStatus?.watch ? 'bg-emerald-400' : 'bg-slate-500'
              }`}
            />
            <span>{buildStatus?.watch ? 'Auto-Watch: ON' : 'Auto-Watch: OFF'}</span>
          </button>

          <button
            type="button"
            disabled={buildBusy}
            onClick={handleRunBuild}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
          >
            <IconRefresh className={`w-3.5 h-3.5 ${buildBusy ? 'animate-spin' : ''}`} />
            <span>{buildBusy ? 'Building...' : 'Run Preset Build'}</span>
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs ${
            banner.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-400 hover:text-white shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {listError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {listError.message}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-borderline">
        <button
          type="button"
          onClick={() => setTab('files')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            tab === 'files'
              ? 'border-accent text-accent'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Files &amp; Code Editor
        </button>
        <button
          type="button"
          onClick={() => setTab('deploy')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            tab === 'deploy'
              ? 'border-accent text-accent'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Git &amp; Auto-Build Logs
        </button>
      </div>

      {tab === 'files' ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left: File Browser */}
          <div className="lg:col-span-5 rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-1 font-mono text-xs text-slate-300">
                <button
                  type="button"
                  onClick={() => setCurrentDir('')}
                  className="hover:text-accent"
                >
                  /
                </button>
                {breadcrumbs.map((seg, idx) => {
                  const target = breadcrumbs.slice(0, idx + 1).join('/');
                  return (
                    <React.Fragment key={target}>
                      <span className="text-slate-600">/</span>
                      <button
                        type="button"
                        onClick={() => setCurrentDir(target)}
                        className="hover:text-accent"
                      >
                        {seg}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setNewFileName('');
                    setNewFileOpen(true);
                  }}
                  className="rounded-md border border-borderline bg-elevated px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                >
                  + File
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewDirName('');
                    setNewDirOpen(true);
                  }}
                  className="rounded-md border border-borderline bg-elevated px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                >
                  + Folder
                </button>
                <button
                  type="button"
                  onClick={() => openUploadModal(!currentDir)}
                  className="rounded-md bg-accent/15 border border-accent/40 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/25"
                >
                  Upload
                </button>
              </div>
            </div>

            <div className="divide-y divide-borderline max-h-[60vh] overflow-y-auto">
              {currentDir !== '' && (
                <button
                  type="button"
                  onClick={() => {
                    const parent = breadcrumbs.slice(0, -1).join('/');
                    setCurrentDir(parent);
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-left font-mono text-xs text-slate-400 hover:bg-elevated/40"
                >
                  <span>..</span>
                  <span className="text-[11px] text-slate-500">(parent directory)</span>
                </button>
              )}

              {entries.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">
                  Empty directory.
                </div>
              ) : (
                entries.map((entry) => {
                  const isManagedLink = entry.path === 'db.php';
                  const active = selectedFile === entry.path;

                  return (
                    <div
                      key={entry.path}
                      className={`flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-elevated/40 ${
                        active ? 'bg-accent/10' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.type === 'dir') {
                            setCurrentDir(entry.path);
                          } else {
                            void openFile(entry.path);
                          }
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              entry.type === 'dir'
                                ? 'bg-sky-500/15 text-sky-300'
                                : entry.type === 'symlink'
                                  ? 'bg-purple-500/15 text-purple-300'
                                  : 'bg-slate-700/40 text-slate-400'
                            }`}
                          >
                            {entry.type === 'dir' ? 'dir' : entry.type === 'symlink' ? 'lnk' : 'file'}
                          </span>
                          <span className="truncate font-mono text-xs text-slate-100">
                            {entry.name}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                          <span>
                            {entry.type === 'dir' ? 'folder' : formatBytes(entry.size)}
                          </span>
                          {entry.mode && (
                            <span
                              className={`rounded px-1 py-0.2 text-[10px] ${
                                entry.mode === '0775'
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : entry.mode === '0640'
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : entry.mode === '0755' && entry.type === 'file'
                                      ? 'bg-sky-500/15 text-sky-300'
                                      : 'bg-slate-700/40 text-slate-400'
                              }`}
                            >
                              {entry.mode}
                            </span>
                          )}
                          <span>· {formatDateTime(entry.modified)}</span>
                        </div>
                      </button>

                      {!isManagedLink && (
                        <div className="flex items-center gap-1 shrink-0">
                          {entry.type !== 'symlink' && (
                            <button
                              type="button"
                              onClick={() => {
                                setPermsTarget(entry);
                                setPermsMode(
                                  entry.mode || (entry.type === 'dir' ? '0755' : '0644')
                                );
                                setPermsRecursive(false);
                              }}
                              className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:bg-elevated hover:text-emerald-300"
                              title="Change POSIX permissions"
                            >
                              Perms
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setRenameTarget(entry);
                              setRenameValue(entry.path);
                            }}
                            className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:bg-elevated hover:text-slate-200"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(entry)}
                            className="rounded p-1 text-rose-400 hover:bg-rose-500/15"
                            title="Delete"
                          >
                            <IconTrash className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: File Editor */}
          <div className="lg:col-span-7 rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
              <div className="font-mono text-xs text-slate-200">
                {selectedFile ? (
                  <>
                    <span>{selectedFile}</span>
                    {hasUnsaved && (
                      <span className="ml-2 text-amber-400">(unsaved)</span>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">Select a file on the left to edit</span>
                )}
              </div>

              {selectedFile && !fileBinary && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={savingFile || !hasUnsaved}
                    onClick={() => void saveFile(false)}
                    className="rounded-lg border border-borderline bg-elevated px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-40"
                  >
                    Save Only
                  </button>
                  <button
                    type="button"
                    disabled={savingFile}
                    onClick={() => void saveFile(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-40"
                  >
                    <IconCheck className="w-3.5 h-3.5" />
                    <span>{savingFile ? 'Saving & Building...' : 'Save & Run Auto-Build'}</span>
                  </button>
                </div>
              )}
            </div>

            {loadingFile ? (
              <div className="p-8 text-center text-xs text-slate-400">Loading file...</div>
            ) : !selectedFile ? (
              <div className="p-10 text-center text-xs text-slate-500 leading-relaxed">
                Browse files inside <span className="font-mono">/var/www/{siteName}</span>, edit <span className="font-mono">.env</span>, source files, or upload a <span className="font-mono">.zip</span> archive. Saving runs the <span className="font-mono">{siteType}</span> preset command automatically.
              </div>
            ) : fileBinary ? (
              <div className="p-8 text-center text-xs text-amber-300">
                Binary file cannot be edited in the text editor.
              </div>
            ) : (
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                spellCheck={false}
                className="flex-1 min-h-[54vh] w-full resize-none bg-[#080b10] p-4 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Git Clone / Pull */}
          <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Git Deployment</h2>
                <p className="text-xs text-slate-400">
                  Clone or pull your repository directly into <span className="font-mono">/var/www/{siteName}</span> (preserving <span className="font-mono">.env</span> and <span className="font-mono">/db.php</span>).
                </p>
              </div>
              <StatusBadge
                tone={git?.initialized ? 'green' : 'slate'}
                label={git?.initialized ? `Branch: ${git.branch || 'main'}` : 'Not initialized'}
                dot
              />
            </div>

            {git?.initialized ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-borderline bg-canvas p-3 font-mono text-xs text-slate-300 space-y-1">
                  <div>
                    Remote: <span className="text-slate-100">{git.remote}</span>
                  </div>
                  {git.status && (
                    <div className="text-amber-300 whitespace-pre-wrap">
                      Working tree:\n{git.status}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={gitAutoBuild}
                      onChange={(e) => setGitAutoBuild(e.target.checked)}
                      className="rounded border-borderline bg-canvas text-accent"
                    />
                    <span>Auto-run preset build after pull</span>
                  </label>
                  <button
                    type="button"
                    disabled={gitBusy}
                    onClick={() => void handleGitAction('pull')}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
                  >
                    {gitBusy ? 'Pulling...' : 'Git Pull & Deploy'}
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleGitAction('clone');
                }}
                className="grid grid-cols-1 gap-3 sm:grid-cols-12"
              >
                <div className="sm:col-span-7">
                  <input
                    type="text"
                    required
                    placeholder="https://github.com/user/repo.git"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-3">
                  <input
                    type="text"
                    placeholder="Branch (default)"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={gitBusy || !repoUrl.trim()}
                    className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
                  >
                    {gitBusy ? 'Cloning...' : 'Clone Repo'}
                  </button>
                </div>
              </form>
            )}
          </section>

          {/* Latest Build Console */}
          <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Preset Build Pipeline Output
                </h2>
                <p className="text-xs text-slate-400">
                  {lastBuild
                    ? `Last run (${lastBuild.trigger}) at ${formatDateTime(lastBuild.finishedAt)}`
                    : 'No build runs recorded yet.'}
                </p>
              </div>
              {lastBuild && (
                <StatusBadge
                  tone={lastBuild.ok ? 'green' : 'red'}
                  label={lastBuild.ok ? 'Build Succeeded' : 'Build Failed'}
                  dot
                />
              )}
            </div>

            <div className="p-5 space-y-4">
              {!lastBuild || lastBuild.steps.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Click &ldquo;Run Preset Build&rdquo; or save/upload files to run the{' '}
                  <span className="font-mono text-slate-300">{siteType}</span> pipeline.
                </p>
              ) : (
                lastBuild.steps.map((step, idx) => (
                  <div
                    key={`${step.cmd}-${idx}`}
                    className="rounded-lg border border-borderline bg-[#080b10] overflow-hidden"
                  >
                    <div className="flex items-center justify-between border-b border-borderline bg-canvas px-3.5 py-2 text-xs font-mono">
                      <span className="text-slate-200">$ {step.cmd}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-500">{step.durationMs}ms</span>
                        <StatusBadge
                          tone={step.ok ? 'green' : 'red'}
                          label={step.ok ? 'OK' : 'FAIL'}
                        />
                      </div>
                    </div>
                    {(step.stdout || step.stderr) && (
                      <pre className="max-h-56 overflow-auto p-3.5 font-mono text-[11px] text-slate-300 whitespace-pre-wrap break-words">
                        {[step.stdout, step.stderr].filter(Boolean).join('\n')}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* New File Modal */}
      <Modal
        open={newFileOpen}
        title="Create New File"
        subtitle={`Created inside /var/www/${siteName}${currentDir ? `/${currentDir}` : ''}`}
        onClose={() => setNewFileOpen(false)}
      >
        <form onSubmit={handleCreateFile} className="space-y-4">
          <input
            type="text"
            autoFocus
            required
            placeholder="e.g. .env or index.html"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNewFileOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950"
            >
              Create &amp; Edit
            </button>
          </div>
        </form>
      </Modal>

      {/* New Folder Modal */}
      <Modal
        open={newDirOpen}
        title="Create Folder"
        onClose={() => setNewDirOpen(false)}
      >
        <form onSubmit={handleCreateDir} className="space-y-4">
          <input
            type="text"
            autoFocus
            required
            placeholder="e.g. src"
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNewDirOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950"
            >
              Create Folder
            </button>
          </div>
        </form>
      </Modal>

      {/* Upload Web App / Files / Folder Modal */}
      <Modal
        open={uploadOpen}
        title="Upload Finished Web App"
        subtitle="Upload a .zip archive, multiple files, or a built folder up to 100 MB (chunked). Symlinks are skipped and /db.php is protected."
        onClose={() => {
          if (!uploading) setUploadOpen(false);
        }}
      >
        <form onSubmit={handleUpload} className="space-y-4">
          {/* Destination selector */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Destination
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={uploading}
                onClick={() => setUploadToRoot(true)}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                  uploadToRoot
                    ? 'border-accent/60 bg-accent/15 text-slate-100'
                    : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
                }`}
              >
                <div className="font-medium">Site Root</div>
                <div className="truncate font-mono text-[10px] text-slate-400">
                  /var/www/{siteName}/
                </div>
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => setUploadToRoot(false)}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                  !uploadToRoot
                    ? 'border-accent/60 bg-accent/15 text-slate-100'
                    : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
                }`}
              >
                <div className="font-medium">Current Folder</div>
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
                setUploadMode('files');
                setUploadFiles([]);
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
                setUploadMode('folder');
                setUploadFiles([]);
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
              if (dropped.length > 0) setUploadFiles(dropped);
            }}
            className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition ${
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
                onChange={(e) =>
                  setUploadFiles(Array.from(e.target.files || []))
                }
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
                onChange={(e) =>
                  setUploadFiles(Array.from(e.target.files || []))
                }
                className="sr-only"
              />
            )}
            <div className="text-xs font-medium text-slate-200">
              {uploadMode === 'files'
                ? 'Click to select a .zip archive or files, or drag & drop here'
                : 'Click to select your built folder (e.g. dist/, build/, out/, or app root)'}
            </div>
            <div className="text-[11px] text-slate-400">
              {uploadMode === 'files'
                ? 'Files over 1.5 MB stream automatically in 2 MB chunks (up to 100 MB)'
                : 'Preserves subfolder structure; skips .git, node_modules, and /db.php'}
            </div>
          </label>

          {/* Queue summary & validation warnings */}
          {uploadFiles.length > 0 && (
            <div className="rounded-lg border border-borderline bg-canvas p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-200">
                <span className="font-medium">
                  Ready: {uploadPlan.validItems.length} file(s) (
                  {(uploadPlan.totalBytes / (1024 * 1024)).toFixed(2)} MB)
                </span>
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => setUploadFiles([])}
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
                  <span className="font-mono">{uploadPlan.invalidPaths[0]}</span>). Rename them or bundle as a clean .zip.
                </div>
              )}

              {uploadPlan.totalBytes > MAX_WEBAPP_UPLOAD_BYTES && (
                <div className="text-[11px] text-rose-400">
                  Total size exceeds the 100 MB limit. Remove unused assets or upload in smaller batches.
                </div>
              )}
            </div>
          )}

          {/* Options */}
          {uploadMode === 'folder' && topFolderName && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                disabled={uploading}
                checked={stripTopFolder}
                onChange={(e) => setStripTopFolder(e.target.checked)}
                className="rounded border-borderline bg-canvas text-accent"
              />
              <span>
                Upload contents directly (strip top folder{' '}
                <span className="font-mono text-slate-200">
                  {topFolderName}/
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
                onChange={(e) => setExtractZip(e.target.checked)}
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
              onChange={(e) => setUploadAutoBuild(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent"
            />
            <span>Automatically run {siteType} build pipeline after upload</span>
          </label>

          <div className="rounded-lg border border-borderline bg-canvas/70 px-3 py-2 text-[11px] text-slate-400">
            <span className="font-medium text-slate-300">Auto-Permissions:</span>{' '}
            Owned by <span className="font-mono text-slate-200">www-data</span> · Folders{' '}
            <span className="font-mono text-slate-200">0755</span> · Files{' '}
            <span className="font-mono text-slate-200">0644</span> ·{' '}
            <span className="font-mono text-slate-200">.env*</span>{' '}
            <span className="font-mono text-amber-300">0640</span> · Binaries/scripts{' '}
            <span className="font-mono text-sky-300">0755</span>
            {siteType === 'laravel' ? (
              <>
                {' '}
                · Laravel <span className="font-mono text-emerald-300">storage/</span> &amp;{' '}
                <span className="font-mono text-emerald-300">bootstrap/cache/</span>{' '}
                <span className="font-mono text-emerald-300">0775</span>
              </>
            ) : null}
          </div>

          {/* Real-time progress bar */}
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
              onClick={() => setUploadOpen(false)}
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

      {/* Rename Modal */}
      <Modal
        open={Boolean(renameTarget)}
        title="Rename / Move"
        onClose={() => setRenameTarget(null)}
      >
        <form onSubmit={handleRename} className="space-y-4">
          <input
            type="text"
            autoFocus
            required
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRenameTarget(null)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950"
            >
              Save Name
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete File Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        title="Delete Path"
        onClose={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div className="space-y-4">
            <p className="text-xs text-slate-300">
              Permanently delete{' '}
              <span className="font-mono font-semibold text-rose-300">
                {deleteTarget.path}
              </span>
              ?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* File / Folder Permissions Modal */}
      <Modal
        open={Boolean(permsTarget)}
        title="File & Folder Permissions"
        subtitle="Files remain owned by www-data:www-data. Use 0775 (not 0777) for framework writable folders like Laravel storage/ and bootstrap/cache/."
        onClose={() => {
          if (!permsBusy) setPermsTarget(null);
        }}
      >
        {permsTarget && (
          <form onSubmit={handleChmod} className="space-y-4">
            <div className="rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-200 truncate">
              /{permsTarget.path} ({permsTarget.type})
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Quick Presets
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
                    disabled={permsBusy}
                    onClick={() => setPermsMode(opt.mode)}
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                      permsMode === opt.mode
                        ? 'border-accent/60 bg-accent/15 text-slate-100'
                        : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    <div className="font-mono font-medium text-slate-200">{opt.label}</div>
                    <div className="text-[10px] text-slate-500">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Octal Mode
              </label>
              <input
                type="text"
                required
                disabled={permsBusy}
                pattern="^0?[0-7]{3}$"
                placeholder="e.g. 0755 or 0775"
                value={permsMode}
                onChange={(e) => setPermsMode(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            {permsTarget.type === 'dir' && (
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={permsBusy}
                  checked={permsRecursive}
                  onChange={(e) => setPermsRecursive(e.target.checked)}
                  className="rounded border-borderline bg-canvas text-accent"
                />
                <span>Apply recursively to all subfolders and files inside</span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={permsBusy}
                onClick={() => setPermsTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={permsBusy}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
              >
                {permsBusy ? 'Applying...' : 'Apply Permissions'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

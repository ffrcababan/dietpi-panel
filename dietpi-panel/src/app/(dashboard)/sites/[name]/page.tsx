'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { IconRefresh, IconShield, IconUpload } from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import {
  DeletePathModal,
  MAX_WEBAPP_UPLOAD_BYTES,
  NewFileModal,
  NewFolderModal,
  PermissionsModal,
  RenameModal,
  UploadWebAppModal,
  type UploadPlan,
} from '@/components/sites/FileManagerModals';
import { SiteDeployTab } from '@/components/sites/SiteDeployTab';
import { SiteFileWorkspace } from '@/components/sites/SiteFileWorkspace';
import type { SiteBuildRecord } from '@/lib/agent';
import { apiFetcher, apiMutate, apiMutateWithStatus } from '@/lib/client-api';
import { FRAMEWORK_PRESETS, type SiteType } from '@/lib/validation';
import type { SiteBuildStatusResponse } from '@/app/api/sites/[name]/build/route';
import type { FileEntry } from '@/app/api/sites/[name]/files/route';
import type { GitStatus } from '@/app/api/sites/[name]/git/route';

const CHUNK_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024);
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

function uint8ToBase64(bytes: Uint8Array): string {
  const sliceSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const sub = bytes.subarray(i, i + sliceSize);
    binary += String.fromCharCode(...Array.from(sub));
  }
  return btoa(binary);
}

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

  // Modals & operations
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<'files' | 'folder'>('files');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadToRoot, setUploadToRoot] = useState(true);
  const [stripTopFolder, setStripTopFolder] = useState(true);
  const [extractZip, setExtractZip] = useState(true);
  const [uploadAutoBuild, setUploadAutoBuild] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    label: string;
  } | null>(null);

  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [permsTarget, setPermsTarget] = useState<FileEntry | null>(null);
  const [permsBusy, setPermsBusy] = useState(false);
  const [fixingPerms, setFixingPerms] = useState(false);

  // Git & Build state
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [gitUsername, setGitUsername] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [saveGitToken, setSaveGitToken] = useState(true);
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
    apiFetcher,
    { keepPreviousData: true }
  );

  const { data: buildStatus, mutate: mutateBuild } =
    useSWR<SiteBuildStatusResponse>(
      `/api/sites/${encodeURIComponent(siteName)}/build`,
      apiFetcher,
      {
        refreshInterval: (latest) => (latest?.building ? 1500 : 4000),
        keepPreviousData: true,
      }
    );

  const { data: gitData, mutate: mutateGit } = useSWR<{ git: GitStatus }>(
    tab === 'deploy' ? `/api/sites/${encodeURIComponent(siteName)}/git` : null,
    apiFetcher,
    { keepPreviousData: true }
  );

  const siteType = (buildStatus?.type || 'custom') as SiteType;
  const preset = FRAMEWORK_PRESETS[siteType] ?? null;
  const entries = listing?.entries ?? [];
  const hasUnsaved = selectedFile !== null && !fileBinary && fileContent !== savedContent;

  const openFile = useCallback(
    async (relPath: string, force = false) => {
      if (!force && hasUnsaved && relPath !== selectedFile) {
        if (!window.confirm('Discard unsaved edits in the current file?')) {
          return;
        }
      }
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
    },
    [hasUnsaved, selectedFile, siteName]
  );

  const saveFile = useCallback(
    async (triggerBuild: boolean) => {
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
    },
    [me?.csrfToken, selectedFile, fileBinary, fileContent, siteName, mutateFiles, mutateBuild]
  );

  const handleCreateFile = async (filename: string) => {
    if (!me?.csrfToken) return;
    const rel = currentDir ? `${currentDir}/${filename}` : filename;
    setCreatingFile(true);
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        { op: 'write', path: rel, content: '', triggerBuild: false }
      );
      setNewFileOpen(false);
      await mutateFiles();
      await openFile(rel, true);
    } finally {
      setCreatingFile(false);
    }
  };

  const handleCreateDir = async (folderName: string) => {
    if (!me?.csrfToken) return;
    const rel = currentDir ? `${currentDir}/${folderName}` : folderName;
    setCreatingDir(true);
    try {
      await apiMutate(
        `/api/sites/${encodeURIComponent(siteName)}/files`,
        'POST',
        me.csrfToken,
        { op: 'mkdir', path: rel }
      );
      setNewDirOpen(false);
      await mutateFiles();
    } finally {
      setCreatingDir(false);
    }
  };

  const openUploadModal = useCallback((toRoot: boolean, prefillFiles: File[] = []) => {
    setUploadToRoot(toRoot);
    setUploadMode('files');
    setUploadFiles(prefillFiles);
    setUploadProgress(null);
    setUploadError(null);
    setUploadOpen(true);
  }, []);

  const handleUpload = async (e: React.FormEvent, uploadPlan: UploadPlan) => {
    e.preventDefault();
    if (!me?.csrfToken || uploadPlan.validItems.length === 0) return;

    if (uploadPlan.invalidPaths.length > 0) {
      setUploadError(
        `Unsupported characters in filename/path: ${uploadPlan.invalidPaths[0]}. Rename or package inside a clean .zip.`
      );
      return;
    }

    if (uploadPlan.totalBytes > MAX_WEBAPP_UPLOAD_BYTES) {
      setUploadError('Total upload size exceeds the 100 MB limit.');
      return;
    }

    setUploading(true);
    setUploadError(null);
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
              label: `Uploading ${stepPrefix} (${(offset / (1024 * 1024)).toFixed(1)} / ${(item.file.size / (1024 * 1024)).toFixed(1)} MB)`,
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
        const buildRes = await apiMutateWithStatus<{
          ok: boolean;
          build: SiteBuildRecord | null;
        }>(`/api/sites/${encodeURIComponent(siteName)}/build`, 'POST', me.csrfToken, {});
        finalBuild = buildRes.data.build ?? null;
        if (!buildRes.ok && !finalBuild) {
          throw new Error(buildRes.data.error || 'Build pipeline failed');
        }
      }

      setUploadProgress({ percent: 100, label: 'Done' });
      setUploadOpen(false);
      setUploadFiles([]);
      setUploadError(null);
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
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
      setBanner({ ok: false, text: msg });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleRename = async (toPath: string) => {
    if (!me?.csrfToken || !renameTarget) return;
    await apiMutate(
      `/api/sites/${encodeURIComponent(siteName)}/files`,
      'POST',
      me.csrfToken,
      {
        op: 'rename',
        fromPath: renameTarget.path,
        toPath,
      }
    );
    if (selectedFile === renameTarget.path) {
      setSelectedFile(toPath);
    }
    setRenameTarget(null);
    await mutateFiles();
  };

  const handleDelete = async () => {
    if (!me?.csrfToken || !deleteTarget) return;
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
        text: `Applied ${me?.webUser || 'www-data'} ownership & ${r.type} permissions (dirs: ${r.dirsUpdated} updated, files: ${r.filesUpdated} updated${
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

  const handleChmod = async (mode: string, recursive: boolean) => {
    if (!me?.csrfToken || !permsTarget || permsBusy) return;
    setPermsBusy(true);
    setBanner(null);
    try {
      const res = await apiMutate<{
        result: { path: string; mode: string; updatedCount: number };
      }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
        op: 'chmod',
        path: permsTarget.path,
        mode,
        recursive: permsTarget.type === 'dir' && recursive,
      });
      setPermsTarget(null);
      setBanner({
        ok: true,
        text: `Updated /${res.result.path} to ${res.result.mode} (${res.result.updatedCount} item(s), owner ${me?.webUser || 'www-data'}).`,
      });
      await mutateFiles();
    } finally {
      setPermsBusy(false);
    }
  };

  const handleRunBuild = async () => {
    if (!me?.csrfToken || buildBusy) return;
    setBuildBusy(true);
    setBanner(null);
    try {
      const { ok, data: json } = await apiMutateWithStatus<{
        ok?: boolean;
        error?: string;
      }>(`/api/sites/${encodeURIComponent(siteName)}/build`, 'POST', me.csrfToken);
      setBanner({
        ok: ok && Boolean(json.ok),
        text:
          ok && json.ok
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

  const handleGitAction = useCallback(
    async (action: 'clone' | 'pull' | 'clearToken') => {
      if (!me?.csrfToken || gitBusy) return;
      setGitBusy(true);
      setBanner(null);
      try {
        if (action === 'clearToken') {
          await apiMutate<{ result: { cleared: boolean } }>(
            `/api/sites/${encodeURIComponent(siteName)}/git`,
            'POST',
            me.csrfToken,
            { action: 'clearToken' }
          );
          setGitToken('');
          setBanner({
            ok: true,
            text: 'Saved Git personal access token cleared from server.',
          });
          await mutateGit();
          return;
        }

        const res = await apiMutate<{
          result: { build?: SiteBuildRecord | null };
        }>(`/api/sites/${encodeURIComponent(siteName)}/git`, 'POST', me.csrfToken, {
          action,
          repoUrl: action === 'clone' ? repoUrl.trim() : undefined,
          branch: branch.trim() || undefined,
          username: gitUsername.trim() || undefined,
          token: gitToken.trim() || undefined,
          saveToken: saveGitToken,
          triggerBuild: gitAutoBuild,
        });
        const b = res.result.build;
        setGitToken('');
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
    },
    [
      me?.csrfToken,
      gitBusy,
      siteName,
      repoUrl,
      branch,
      gitUsername,
      gitToken,
      saveGitToken,
      gitAutoBuild,
      mutateGit,
      mutateFiles,
      mutateBuild,
    ]
  );

  const handleRefreshFiles = useCallback(() => {
    void mutateFiles();
  }, [mutateFiles]);

  const handleDropFilesToCurrentDir = useCallback(
    (dropped: File[]) => {
      openUploadModal(!currentDir, dropped);
    },
    [currentDir, openUploadModal]
  );

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

        {!listError && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openUploadModal(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-accent/50 bg-accent/15 px-3.5 py-2 text-xs font-semibold text-accent hover:bg-accent/25 transition"
            >
              <IconUpload className="w-3.5 h-3.5" />
              <span>Upload Web App</span>
            </button>

            <button
              type="button"
              disabled={fixingPerms}
              onClick={handleFixPermissions}
              className="inline-flex items-center gap-2 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50 transition"
              title={`Apply ${me?.webUser || 'www-data'} ownership and recommended framework file/folder permissions (755/644, +x binaries, Laravel 775 storage)`}
            >
              <IconShield className="w-3.5 h-3.5 text-emerald-400" />
              <span>{fixingPerms ? 'Fixing...' : 'Fix Permissions'}</span>
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
        )}
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

      {listError ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-5 py-4 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
          <span>{listError.message}</span>
          <Link
            href="/sites"
            className="rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
          >
            Back to Sites
          </Link>
        </div>
      ) : (
        <>
          {/* Workspace Tabs */}
          <div className="flex items-center gap-2 border-b border-borderline pb-3">
            <button
              type="button"
              onClick={() => setTab('files')}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                tab === 'files'
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              File Manager
            </button>
            <button
              type="button"
              onClick={() => setTab('deploy')}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                tab === 'deploy'
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Git &amp; Build Logs
            </button>
          </div>

          {tab === 'files' ? (
            <SiteFileWorkspace
              siteName={siteName}
              siteType={siteType}
              currentDir={currentDir}
              entries={entries}
              selectedFile={selectedFile}
              fileContent={fileContent}
              fileBinary={fileBinary}
              hasUnsaved={hasUnsaved}
              loadingFile={loadingFile}
              savingFile={savingFile}
              onChangeDir={setCurrentDir}
              onRefreshFiles={handleRefreshFiles}
              onOpenFile={openFile}
              onChangeContent={setFileContent}
              onSaveFile={saveFile}
              onOpenNewFile={() => setNewFileOpen(true)}
              onOpenNewFolder={() => setNewDirOpen(true)}
              onOpenUpload={() => openUploadModal(!currentDir)}
              onDropFilesToCurrentDir={handleDropFilesToCurrentDir}
              onOpenPerms={setPermsTarget}
              onOpenRename={setRenameTarget}
              onOpenDelete={setDeleteTarget}
            />
          ) : (
            <SiteDeployTab
              siteName={siteName}
              siteType={siteType}
              git={gitData?.git}
              lastBuild={buildStatus?.lastBuild}
              repoUrl={repoUrl}
              branch={branch}
              gitUsername={gitUsername}
              gitToken={gitToken}
              saveGitToken={saveGitToken}
              gitAutoBuild={gitAutoBuild}
              gitBusy={gitBusy}
              onChangeRepoUrl={setRepoUrl}
              onChangeBranch={setBranch}
              onChangeGitUsername={setGitUsername}
              onChangeGitToken={setGitToken}
              onChangeSaveGitToken={setSaveGitToken}
              onChangeGitAutoBuild={setGitAutoBuild}
              onGitAction={handleGitAction}
            />
          )}
        </>
      )}

      {/* Modular File Manager Modals */}
      <NewFileModal
        open={newFileOpen}
        siteName={siteName}
        currentDir={currentDir}
        busy={creatingFile}
        onClose={() => setNewFileOpen(false)}
        onCreate={handleCreateFile}
      />

      <NewFolderModal
        open={newDirOpen}
        siteName={siteName}
        currentDir={currentDir}
        busy={creatingDir}
        onClose={() => setNewDirOpen(false)}
        onCreate={handleCreateDir}
      />

      <UploadWebAppModal
        open={uploadOpen}
        siteName={siteName}
        siteType={siteType}
        currentDir={currentDir}
        uploadMode={uploadMode}
        uploadFiles={uploadFiles}
        uploadToRoot={uploadToRoot}
        stripTopFolder={stripTopFolder}
        extractZip={extractZip}
        uploadAutoBuild={uploadAutoBuild}
        uploading={uploading}
        uploadProgress={uploadProgress}
        uploadError={uploadError}
        onClose={() => {
          setUploadError(null);
          setUploadOpen(false);
        }}
        onChangeMode={setUploadMode}
        onChangeFiles={setUploadFiles}
        onChangeToRoot={setUploadToRoot}
        onChangeStripTop={setStripTopFolder}
        onChangeExtractZip={setExtractZip}
        onChangeAutoBuild={setUploadAutoBuild}
        onSubmit={handleUpload}
      />

      <PermissionsModal
        target={permsTarget}
        busy={permsBusy}
        onClose={() => setPermsTarget(null)}
        onSubmit={handleChmod}
      />

      <RenameModal
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRename={handleRename}
      />

      <DeletePathModal
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDelete={handleDelete}
      />
    </div>
  );
}

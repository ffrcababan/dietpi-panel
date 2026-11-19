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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [extractZip, setExtractZip] = useState(true);
  const [uploadAutoBuild, setUploadAutoBuild] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

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

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !uploadFile) return;
    if (uploadFile.size > 8 * 1024 * 1024) {
      setBanner({ ok: false, text: 'Max upload size is 8 MB.' });
      return;
    }

    setUploading(true);
    setBanner(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = String(reader.result || '');
          const comma = res.indexOf(',');
          resolve(comma !== -1 ? res.slice(comma + 1) : res);
        };
        reader.onerror = () => reject(new Error('Failed to read local file'));
        reader.readAsDataURL(uploadFile);
      });

      const res = await apiMutate<{
        result: {
          path: string;
          bytes: number;
          extractedFiles: number;
          build: SiteBuildRecord | null;
        };
      }>(`/api/sites/${encodeURIComponent(siteName)}/files`, 'POST', me.csrfToken, {
        op: 'upload',
        dir: currentDir,
        filename: uploadFile.name,
        contentBase64: base64,
        extractZip: uploadFile.name.toLowerCase().endsWith('.zip') && extractZip,
        triggerBuild: uploadAutoBuild,
      });

      setUploadOpen(false);
      setUploadFile(null);
      const b = res.result.build;
      setBanner({
        ok: b ? b.ok : true,
        text:
          res.result.extractedFiles > 0
            ? `Extracted ${res.result.extractedFiles} file(s)${b ? ` · build ${b.ok ? 'succeeded' : 'failed'}` : ''}.`
            : `Uploaded ${res.result.path}${b ? ` · build ${b.ok ? 'succeeded' : 'failed'}` : ''}.`,
      });
      await Promise.all([mutateFiles(), mutateBuild()]);
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Upload failed',
      });
    } finally {
      setUploading(false);
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
                  onClick={() => {
                    setUploadFile(null);
                    setUploadOpen(true);
                  }}
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
                        <div className="mt-0.5 text-[11px] text-slate-500 font-mono">
                          {entry.type === 'dir' ? 'folder' : formatBytes(entry.size)} ·{' '}
                          {formatDateTime(entry.modified)}
                        </div>
                      </button>

                      {!isManagedLink && (
                        <div className="flex items-center gap-1 shrink-0">
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

      {/* Upload File / Zip Modal */}
      <Modal
        open={uploadOpen}
        title="Upload File or .zip Archive"
        subtitle="Max 8 MB per upload. Safe extraction skips symlinks and preserves /db.php."
        onClose={() => setUploadOpen(false)}
      >
        <form onSubmit={handleUpload} className="space-y-4">
          <input
            type="file"
            required
            onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
            className="w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-200"
          />

          {uploadFile?.name.toLowerCase().endsWith('.zip') && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={extractZip}
                onChange={(e) => setExtractZip(e.target.checked)}
                className="rounded border-borderline bg-canvas text-accent"
              />
              <span>Extract .zip contents into current folder</span>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={uploadAutoBuild}
              onChange={(e) => setUploadAutoBuild(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent"
            />
            <span>Automatically run {siteType} build pipeline after upload</span>
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUploadOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!uploadFile || uploading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
            >
              <IconPlus className="w-3.5 h-3.5" />
              <span>{uploading ? 'Uploading...' : 'Upload'}</span>
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
    </div>
  );
}

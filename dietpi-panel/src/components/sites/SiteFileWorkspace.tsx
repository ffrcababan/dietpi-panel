'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  IconCheck,
  IconFile,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '@/components/Icons';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { FileEntry } from '@/app/api/sites/[name]/files/route';

export const SiteFileWorkspace = React.memo(function SiteFileWorkspace({
  siteName,
  siteType,
  currentDir,
  entries,
  selectedFile,
  fileContent,
  fileBinary,
  hasUnsaved,
  loadingFile,
  savingFile,
  onChangeDir,
  onRefreshFiles,
  onOpenFile,
  onChangeContent,
  onSaveFile,
  onOpenNewFile,
  onOpenNewFolder,
  onOpenUpload,
  onDropFilesToCurrentDir,
  onOpenPerms,
  onOpenRename,
  onOpenDelete,
}: {
  siteName: string;
  siteType: string;
  currentDir: string;
  entries: FileEntry[];
  selectedFile: string | null;
  fileContent: string;
  fileBinary: boolean;
  hasUnsaved: boolean;
  loadingFile: boolean;
  savingFile: boolean;
  onChangeDir: (dir: string) => void;
  onRefreshFiles: () => void;
  onOpenFile: (path: string) => void;
  onChangeContent: (next: string) => void;
  onSaveFile: (triggerBuild: boolean) => void;
  onOpenNewFile: () => void;
  onOpenNewFolder: () => void;
  onOpenUpload: () => void;
  onDropFilesToCurrentDir: (files: File[]) => void;
  onOpenPerms: (entry: FileEntry) => void;
  onOpenRename: (entry: FileEntry) => void;
  onOpenDelete: (entry: FileEntry) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified'>('name');
  const [wordWrap, setWordWrap] = useState(false);
  const [paneDragOver, setPaneDragOver] = useState(false);

  const breadcrumbs = useMemo(
    () => (currentDir ? currentDir.split('/').filter(Boolean) : []),
    [currentDir]
  );

  // Reset search when switching directories
  useEffect(() => {
    setSearchQuery('');
  }, [currentDir]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = q
      ? entries.filter((e) => e.name.toLowerCase().includes(q))
      : [...entries];

    list.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      if (sortBy === 'size') return b.size - a.size;
      if (sortBy === 'modified') return b.modified.localeCompare(a.modified);
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [entries, searchQuery, sortBy]);

  const activeEntry = useMemo(
    () => entries.find((e) => e.path === selectedFile) ?? null,
    [entries, selectedFile]
  );

  const editorStats = useMemo(() => {
    if (!selectedFile || fileBinary) return null;
    const lines = fileContent === '' ? 1 : fileContent.split('\n').length;
    return { lines, chars: fileContent.length };
  }, [selectedFile, fileBinary, fileContent]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left: Optimized File Browser */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setPaneDragOver(true);
        }}
        onDragLeave={() => setPaneDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setPaneDragOver(false);
          const dropped = Array.from(e.dataTransfer?.files || []);
          if (dropped.length > 0) onDropFilesToCurrentDir(dropped);
        }}
        className={`lg:col-span-5 rounded-xl border bg-surface overflow-hidden transition ${
          paneDragOver
            ? 'border-accent ring-2 ring-accent/30'
            : 'border-borderline'
        }`}
      >
        {/* Breadcrumb + Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
          <div className="flex items-center gap-1 text-xs font-mono text-slate-300 overflow-x-auto">
            <button
              type="button"
              onClick={() => onChangeDir('')}
              className="hover:text-accent shrink-0"
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
                    onClick={() => onChangeDir(target)}
                    className="hover:text-accent shrink-0"
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
              onClick={onRefreshFiles}
              title="Refresh directory"
              className="rounded-md border border-borderline bg-elevated p-1.5 text-slate-300 hover:border-slate-500 hover:text-white"
            >
              <IconRefresh className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={onOpenNewFile}
              className="rounded-md border border-borderline bg-elevated px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
            >
              + File
            </button>
            <button
              type="button"
              onClick={onOpenNewFolder}
              className="rounded-md border border-borderline bg-elevated px-2 py-1 text-[11px] text-slate-200 hover:border-slate-500"
            >
              + Folder
            </button>
            <button
              type="button"
              onClick={onOpenUpload}
              className="rounded-md bg-accent/15 border border-accent/40 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/25"
            >
              Upload
            </button>
          </div>
        </div>

        {/* Search & Sort Bar */}
        <div className="flex items-center gap-2 border-b border-borderline bg-canvas/30 px-3 py-2">
          <div className="relative flex-1">
            <IconSearch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              placeholder={`Filter ${entries.length} item(s)...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-borderline bg-canvas pl-8 pr-2.5 py-1 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'name' | 'size' | 'modified')}
            aria-label="Sort files"
            className="rounded-md border border-borderline bg-canvas px-2 py-1 text-[11px] text-slate-300 focus:border-accent focus:outline-none"
          >
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="modified">Modified</option>
          </select>
        </div>

        {/* Directory Entries */}
        <div className="divide-y divide-borderline max-h-[58vh] overflow-y-auto">
          {currentDir !== '' && (
            <button
              type="button"
              onClick={() => onChangeDir(breadcrumbs.slice(0, -1).join('/'))}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-left font-mono text-xs text-slate-400 hover:bg-elevated/40"
            >
              <IconFolder className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span>..</span>
              <span className="text-[11px] text-slate-500">(parent directory)</span>
            </button>
          )}

          {filteredEntries.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-slate-500">
              {entries.length === 0
                ? 'Empty directory — drag & drop a .zip or files here, or click Upload.'
                : 'No matching files or folders.'}
            </div>
          ) : (
            filteredEntries.map((entry) => {
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
                        onChangeDir(entry.path);
                      } else {
                        onOpenFile(entry.path);
                      }
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {entry.type === 'dir' ? (
                        <IconFolder className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      ) : entry.type === 'symlink' ? (
                        <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-purple-300 shrink-0">
                          lnk
                        </span>
                      ) : (
                        <IconFile className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                      <span className="truncate font-mono text-xs text-slate-100">
                        {entry.name}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono pl-5">
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
                          onClick={() => onOpenPerms(entry)}
                          className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:bg-elevated hover:text-emerald-300"
                          title="Change POSIX permissions"
                        >
                          Perms
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenRename(entry)}
                        className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:bg-elevated hover:text-slate-200"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenDelete(entry)}
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

      {/* Right: Optimized Code Editor */}
      <div className="lg:col-span-7 rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-slate-200 min-w-0">
            {selectedFile ? (
              <>
                <span className="truncate">{selectedFile}</span>
                {activeEntry?.mode && (
                  <button
                    type="button"
                    onClick={() => onOpenPerms(activeEntry)}
                    className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-emerald-300"
                    title="Change permissions"
                  >
                    {activeEntry.mode}
                  </button>
                )}
                {hasUnsaved && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                    unsaved
                  </span>
                )}
              </>
            ) : (
              <span className="text-slate-500">Select a file on the left to edit</span>
            )}
          </div>

          {selectedFile && !fileBinary && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setWordWrap((w) => !w)}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
                  wordWrap
                    ? 'border-accent/40 bg-accent/15 text-accent'
                    : 'border-borderline bg-elevated text-slate-300 hover:border-slate-500'
                }`}
              >
                Wrap
              </button>
              <button
                type="button"
                disabled={savingFile || !hasUnsaved}
                onClick={() => onSaveFile(false)}
                className="rounded-lg border border-borderline bg-elevated px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-40"
              >
                Save Only
              </button>
              <button
                type="button"
                disabled={savingFile}
                onClick={() => onSaveFile(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-40"
              >
                <IconCheck className="w-3.5 h-3.5" />
                <span>{savingFile ? 'Saving...' : 'Save & Rebuild'}</span>
              </button>
            </div>
          )}
        </div>

        {loadingFile ? (
          <div className="p-8 text-center text-xs text-slate-400">Loading file...</div>
        ) : !selectedFile ? (
          <div className="p-10 text-center text-xs text-slate-500 leading-relaxed flex-1 flex flex-col items-center justify-center">
            <p>
              Browse or search files inside{' '}
              <span className="font-mono text-slate-300">/var/www/{siteName}</span>, edit{' '}
              <span className="font-mono text-slate-300">.env</span>, adjust POSIX permissions, or upload your finished app.
            </p>
            <p className="mt-2 text-[11px] text-slate-600">
              Tip: drag &amp; drop a <span className="font-mono">.zip</span> archive directly onto the file browser on the left.
            </p>
          </div>
        ) : fileBinary ? (
          <div className="p-8 text-center text-xs text-amber-300 flex-1 flex items-center justify-center">
            Binary file cannot be edited in the text editor.
          </div>
        ) : (
          <>
            <textarea
              value={fileContent}
              onChange={(e) => onChangeContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  if (hasUnsaved && !savingFile) onSaveFile(false);
                }
              }}
              spellCheck={false}
              wrap={wordWrap ? 'soft' : 'off'}
              className="flex-1 min-h-[54vh] w-full resize-none bg-[#080b10] p-4 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none"
            />
            {editorStats && (
              <div className="flex items-center justify-between border-t border-borderline bg-canvas/50 px-4 py-1.5 font-mono text-[11px] text-slate-500">
                <span>
                  {editorStats.lines} lines · {editorStats.chars} chars · {siteType}
                </span>
                <span>Ctrl/Cmd + S to save</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import {
  IconCheck,
  IconCopy,
  IconPlus,
  IconTrash,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import type { TunnelActionResult } from '@/lib/agent';
import { formatBytes, formatDateTime, formatTunnelSummary } from '@/lib/format';
import { NAME_RE, RESERVED_NAMES } from '@/lib/validation';
import type {
  CreateDatabaseResult,
  DatabaseRecord,
} from '@/app/api/databases/route';

export default function DatabasesPage() {
  const { me } = usePanel();
  const { data, error, mutate } = useSWR<{ databases: DatabaseRecord[] }>(
    '/api/databases',
    apiFetcher,
    { refreshInterval: 5000 }
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [createdInfo, setCreatedInfo] = useState<CreateDatabaseResult | null>(null);
  const [copiedField, setCopiedField] = useState<'key' | 'curl' | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<DatabaseRecord | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tunnelBanner, setTunnelBanner] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const databases = data?.databases ?? [];
  const baseDomain = me?.baseDomain || 'mydomain.com';

  const nameValidationError = (() => {
    if (!newName) return null;
    if (!NAME_RE.test(newName)) {
      return 'Use 1-32 lowercase letters, numbers, or hyphens only.';
    }
    if (RESERVED_NAMES.has(newName)) {
      return `"${newName}" is reserved and cannot be used.`;
    }
    return null;
  })();

  const isCreateValid =
    newName.length > 0 && NAME_RE.test(newName) && !RESERVED_NAMES.has(newName);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !isCreateValid) return;

    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiMutate<{ database: CreateDatabaseResult }>(
        '/api/databases',
        'POST',
        me.csrfToken,
        { name: newName }
      );
      setCreateOpen(false);
      setNewName('');
      setCreatedInfo(res.database);
      await mutate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create database');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !deleteTarget || confirmName !== deleteTarget.name) return;

    setDeleting(true);
    setDeleteError(null);
    setTunnelBanner(null);
    try {
      const res = await apiMutate<{
        deleted: { tunnel?: TunnelActionResult };
      }>(
        `/api/databases/${encodeURIComponent(deleteTarget.name)}`,
        'DELETE',
        me.csrfToken
      );
      setDeleteTarget(null);
      setConfirmName('');
      const summary = formatTunnelSummary(res.deleted?.tunnel);
      if (summary) setTunnelBanner(summary);
      await mutate();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to archive database');
    } finally {
      setDeleting(false);
    }
  };

  const copyText = async (text: string, field: 'key' | 'curl') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Clipboard blocked in non-HTTPS test contexts
    }
  };

  const curlSnippet = createdInfo
    ? `curl -s -X POST https://${createdInfo.domain}/db.php \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: ${createdInfo.apiKey}" \\\n  -d '{"sql":"SELECT sqlite_version() AS version"}'`
    : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            SQLite Databases
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Per-app WAL-mode SQLite databases with D1-style HTTP endpoints.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNewName('');
            setCreateError(null);
            setCreateOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-accent-hover transition"
        >
          <IconPlus className="w-4 h-4" />
          <span>Create Database</span>
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}

      {tunnelBanner && (
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs ${
            tunnelBanner.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          <span>{tunnelBanner.text}</span>
          <button
            type="button"
            onClick={() => setTunnelBanner(null)}
            className="text-slate-400 hover:text-white shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-borderline bg-canvas/50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">HTTP Endpoint</th>
                <th className="px-5 py-3 font-medium">Vhost Type</th>
                <th className="px-5 py-3 font-medium">Size</th>
                <th className="px-5 py-3 font-medium">Modified</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderline">
              {databases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                    No databases provisioned yet. Click &ldquo;Create Database&rdquo; to create your first SQLite instance.
                  </td>
                </tr>
              ) : (
                databases.map((db) => (
                  <tr key={db.name} className="hover:bg-elevated/40">
                    <td className="px-5 py-3.5 font-mono font-medium text-slate-100">
                      {db.name}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-300">
                      https://{db.domain}/db.php
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge
                        tone={db.siteType === 'dbonly' ? 'slate' : 'blue'}
                        label={db.siteType === 'dbonly' ? 'DB API only' : db.siteType}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-300">
                      {formatBytes(db.sizeBytes)}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-400">
                      {formatDateTime(db.modified)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmName('');
                          setDeleteError(null);
                          setDeleteTarget(db);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition"
                      >
                        <IconTrash className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Database Modal */}
      <Modal
        open={createOpen}
        title="Create SQLite Database"
        subtitle="Creates a WAL-mode SQLite file, random API key, and /db.php endpoint."
        onClose={() => setCreateOpen(false)}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {createError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {createError}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Database / App Name
            </label>
            <input
              type="text"
              autoFocus
              required
              placeholder="e.g. notes-app"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toLowerCase())}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
            {nameValidationError ? (
              <p className="mt-1.5 text-xs text-rose-400">{nameValidationError}</p>
            ) : (
              <p className="mt-1.5 text-xs text-slate-500">
                Allowed: lowercase letters, digits, hyphens (1-32 chars).
              </p>
            )}
          </div>

          <div className="rounded-lg border border-borderline bg-canvas p-3 space-y-1 text-xs font-mono">
            <div className="text-slate-400">
              DB file:{' '}
              <span className="text-slate-200">
                /srv/db/{newName || '<name>'}/data.sqlite
              </span>
            </div>
            <div className="text-slate-400">
              Endpoint:{' '}
              <span className="text-slate-200">
                https://{newName || '<name>'}.{baseDomain}/db.php
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isCreateValid || creating}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {creating ? 'Provisioning...' : 'Create Database'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reveal-Once API Key Modal */}
      <Modal
        open={Boolean(createdInfo)}
        title="Database Provisioned — Copy Your API Key"
        subtitle="Store this key securely now. It is stored only in root-protected Apache config and will never be displayed again."
        onClose={() => setCreatedInfo(null)}
        maxWidthClass="max-w-xl"
      >
        {createdInfo && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              Reveal-once secret: closing this dialog permanently hides the API key.
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-slate-300">
                  x-api-key for <span className="font-mono text-slate-100">{createdInfo.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => copyText(createdInfo.apiKey, 'key')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-borderline bg-elevated px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500"
                >
                  {copiedField === 'key' ? (
                    <>
                      <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <IconCopy className="w-3.5 h-3.5" />
                      <span>Copy Key</span>
                    </>
                  )}
                </button>
              </div>
              <div className="rounded-lg border border-borderline bg-canvas p-3 font-mono text-xs text-emerald-300 break-all select-all">
                {createdInfo.apiKey}
              </div>
            </div>

            {(() => {
              const summary = formatTunnelSummary(createdInfo.tunnel);
              if (!summary) return null;
              return (
                <div
                  className={`rounded-lg border px-3.5 py-2 text-xs ${
                    summary.ok
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  }`}
                >
                  {summary.text}
                </div>
              );
            })()}

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-slate-300">
                  Verify with curl
                </span>
                <button
                  type="button"
                  onClick={() => copyText(curlSnippet, 'curl')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-borderline bg-elevated px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500"
                >
                  {copiedField === 'curl' ? (
                    <>
                      <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <IconCopy className="w-3.5 h-3.5" />
                      <span>Copy curl</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="rounded-lg border border-borderline bg-canvas p-3 font-mono text-[11px] text-slate-300 overflow-x-auto">
                {curlSnippet}
              </pre>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setCreatedInfo(null)}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
              >
                I Have Saved the Key
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Type-to-Confirm Delete Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        title="Archive Database"
        subtitle="Moves /srv/db/<name> to /srv/db/backups/trash-<name>-<timestamp> (soft delete)."
        onClose={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <form onSubmit={handleDelete} className="space-y-4">
            {deleteError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
                {deleteError}
              </div>
            )}

            <p className="text-xs text-slate-300 leading-relaxed">
              This will disable API access for{' '}
              <span className="font-mono font-semibold text-slate-100">
                {deleteTarget.name}
              </span>{' '}
              and move its SQLite directory into{' '}
              <span className="font-mono text-slate-200">/srv/db/backups/</span>.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Type <span className="font-mono text-rose-300">{deleteTarget.name}</span> to confirm
              </label>
              <input
                type="text"
                autoFocus
                required
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={deleteTarget.name}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-rose-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={confirmName !== deleteTarget.name || deleting}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40 transition"
              >
                {deleting ? 'Archiving...' : 'Archive Database'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

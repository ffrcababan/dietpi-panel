'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { IconLock, IconPlus, IconTrash } from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import {
  RevealKeyModal,
  type ProvisionedDatabaseInfo,
} from '@/components/RevealKeyModal';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate, apiMutateWithStatus } from '@/lib/client-api';
import type { TunnelActionResult } from '@/lib/agent';
import { formatTunnelSummary } from '@/lib/format';
import {
  DOMAIN_RE,
  FRAMEWORK_PRESETS,
  NAME_RE,
  RESERVED_NAMES,
  SITE_TYPES,
  type SiteType,
} from '@/lib/validation';
import type { CreateSiteResponse, SiteRecord } from '@/app/api/sites/route';

export default function SitesPage() {
  const { me } = usePanel();
  const { data, error, mutate } = useSWR<{ sites: SiteRecord[] }>(
    '/api/sites',
    apiFetcher,
    { refreshInterval: 5000, keepPreviousData: true }
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [siteType, setSiteType] = useState<SiteType>('static');
  const [customDomain, setCustomDomain] = useState('');
  const [customPort, setCustomPort] = useState('');
  const [createDb, setCreateDb] = useState(true);
  const [enableWatch, setEnableWatch] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [provisionedDb, setProvisionedDb] = useState<ProvisionedDatabaseInfo | null>(
    null
  );

  const [certOpen, setCertOpen] = useState(false);
  const [certDomain, setCertDomain] = useState('');
  const [certDryRun, setCertDryRun] = useState(false);
  const [certRunning, setCertRunning] = useState(false);
  const [certResult, setCertResult] = useState<{
    ok: boolean;
    stdout: string;
    stderr: string;
  } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<SiteRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [routingDomain, setRoutingDomain] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const sites = data?.sites ?? [];
  const baseDomain = me?.baseDomain || 'mydomain.com';
  const selectedPreset = FRAMEWORK_PRESETS[siteType];

  const nameError = (() => {
    if (!name) return null;
    if (!NAME_RE.test(name)) return 'Use 1-32 lowercase letters, digits, or hyphens.';
    if (RESERVED_NAMES.has(name)) return `"${name}" is a reserved name.`;
    return null;
  })();

  const domainError = (() => {
    const trimmed = customDomain.trim().toLowerCase();
    if (!trimmed) return null;
    if (!DOMAIN_RE.test(trimmed)) return 'Enter a valid domain (e.g. app.example.com).';
    return null;
  })();

  const isFormValid =
    name.length > 0 &&
    NAME_RE.test(name) &&
    !RESERVED_NAMES.has(name) &&
    !domainError;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !isFormValid) return;

    setCreating(true);
    setCreateError(null);
    setBanner(null);
    try {
      const res = await apiMutate<{ site: CreateSiteResponse }>(
        '/api/sites',
        'POST',
        me.csrfToken,
        {
          name,
          type: siteType,
          domain: customDomain.trim() || undefined,
          port:
            selectedPreset.hasPort && customPort.trim()
              ? Number.parseInt(customPort.trim(), 10)
              : undefined,
          createDb,
          watch: enableWatch,
        }
      );

      setCreateOpen(false);
      setName('');
      setCustomDomain('');
      setCustomPort('');

      if (res.site.database) {
        setProvisionedDb({
          name: res.site.database.name,
          domain: res.site.database.domain,
          dbPath: res.site.database.dbPath,
          apiKey: res.site.database.apiKey,
          envFile: res.site.envFile,
          tunnel: res.site.tunnel,
        });
      } else {
        const tunnelMsg = formatTunnelSummary(res.site.tunnel);
        if (res.site.dbError) {
          setBanner({ ok: false, text: `Site created, but DB error: ${res.site.dbError}` });
        } else if (tunnelMsg) {
          setBanner(tunnelMsg);
        } else {
          setBanner({ ok: true, text: `Created ${res.site.domain} (${res.site.type}).` });
        }
      }

      await mutate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create site');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!me?.csrfToken || !deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    setBanner(null);
    try {
      const res = await apiMutate<{
        deleted: { tunnel?: TunnelActionResult };
      }>(
        `/api/sites/${encodeURIComponent(deleteTarget.name)}`,
        'DELETE',
        me.csrfToken
      );
      setDeleteTarget(null);
      const summary = formatTunnelSummary(res.deleted?.tunnel);
      if (summary) setBanner(summary);
      await mutate();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to archive site');
    } finally {
      setDeleting(false);
    }
  };

  const handleRouteTunnel = async (domain: string) => {
    if (!me?.csrfToken || routingDomain) return;
    setRoutingDomain(domain);
    setBanner(null);
    try {
      const res = await apiMutate<{ tunnel: TunnelActionResult }>(
        '/api/tunnel',
        'POST',
        me.csrfToken,
        { domain }
      );
      const summary = formatTunnelSummary(res.tunnel);
      if (summary) setBanner(summary);
      await mutate();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to route tunnel',
      });
    } finally {
      setRoutingDomain(null);
    }
  };

  const openCertModal = (domain = '') => {
    setCertDomain(domain);
    setCertDryRun(false);
    setCertResult(null);
    setCertOpen(true);
  };

  const handleCertSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !certDomain.trim()) return;

    setCertRunning(true);
    setCertResult(null);
    try {
      const { ok, data: json } = await apiMutateWithStatus<{
        ok?: boolean;
        stdout?: string;
        stderr?: string;
        error?: string;
      }>('/api/cert', 'POST', me.csrfToken, {
        domain: certDomain.trim().toLowerCase(),
        dryRun: certDryRun,
      });
      setCertResult({
        ok: ok && Boolean(json.ok),
        stdout: json.stdout || '',
        stderr: json.stderr || json.error || '',
      });
      if (ok && json.ok && !certDryRun) {
        await mutate();
      }
    } catch (err) {
      setCertResult({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : 'Failed to run certbot',
      });
    } finally {
      setCertRunning(false);
    }
  };

  const typeTone = (t: string): 'blue' | 'amber' | 'green' | 'slate' => {
    if (t === 'nextjs' || t === 'node' || t === 'python') return 'blue';
    if (t === 'php' || t === 'laravel') return 'amber';
    if (t === 'static' || t === 'react' || t === 'vue' || t === 'astro' || t === 'sveltekit') {
      return 'green';
    }
    return 'slate';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Sites &amp; Web Apps
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Apache virtual hosts, auto-created SQLite databases, Cloudflare Tunnel routing, file management, and preset builds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openCertModal(sites.find((s) => !s.ssl)?.serverName || '')}
            className="inline-flex items-center gap-2 rounded-lg border border-borderline bg-surface px-3.5 py-2 text-sm font-medium text-slate-200 hover:border-slate-500 transition"
          >
            <IconLock className="w-4 h-4 text-emerald-400" />
            <span>Issue TLS Cert</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setName('');
              setSiteType('static');
              setCustomDomain('');
              setCustomPort('');
              setCreateDb(true);
              setEnableWatch(false);
              setCreateError(null);
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-accent-hover transition"
          >
            <IconPlus className="w-4 h-4" />
            <span>Create Site</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}

      {banner && (
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs ${
            banner.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
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

      <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-borderline bg-canvas/50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Domain</th>
                <th className="px-5 py-3 font-medium">Framework</th>
                <th className="px-5 py-3 font-medium">Tunnel</th>
                <th className="px-5 py-3 font-medium">Origin TLS</th>
                <th className="px-5 py-3 font-medium">Target / Docroot</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderline">
              {sites.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                    No enabled sites found.
                  </td>
                </tr>
              ) : (
                sites.map((site) => (
                  <tr key={`${site.name}-${site.serverName}`} className="hover:bg-elevated/40">
                    <td className="px-5 py-3.5">
                      <a
                        href={`https://${site.serverName}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm font-medium text-slate-100 hover:text-accent transition"
                      >
                        {site.serverName}
                      </a>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <span>{site.name}</span>
                        {site.hasDb && <span className="text-sky-400">• SQLite</span>}
                        {site.watch && <span className="text-emerald-400">• Watch ON</span>}
                        {me?.role === 'admin' && site.ownerUsername && (
                          <span className="font-mono text-slate-400">• @{site.ownerUsername}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge
                        tone={typeTone(site.type)}
                        label={site.type === 'dbonly' ? 'db-only' : site.type}
                      />
                    </td>
                    <td className="px-5 py-3.5">
                      {site.tunnel === undefined ? (
                        <StatusBadge tone="slate" label="Local" />
                      ) : site.tunnel ? (
                        <StatusBadge tone="green" label="Cloudflare" dot />
                      ) : (
                        <button
                          type="button"
                          disabled={routingDomain === site.serverName}
                          onClick={() => handleRouteTunnel(site.serverName)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 transition"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                          <span>
                            {routingDomain === site.serverName ? 'Routing...' : 'Unrouted · Route'}
                          </span>
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {site.ssl ? (
                        <StatusBadge tone="green" label="TLS Active" dot />
                      ) : (
                        <button
                          type="button"
                          onClick={() => openCertModal(site.serverName)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          <span>HTTP :80 · Certbot</span>
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-400">
                      <div>{site.docroot}</div>
                      {site.port ? (
                        <div className="text-[11px] text-sky-400">
                          Proxy 127.0.0.1:{site.port}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3.5 text-right whitespace-nowrap space-x-2">
                      {site.isPanel ? (
                        <span className="text-xs text-slate-500">Protected</span>
                      ) : site.type === 'dbonly' ? (
                        <span
                          className="text-xs text-slate-500"
                          title="Managed by database lifecycle; delete on /databases or upgrade via Create Site"
                        >
                          Via Databases
                        </span>
                      ) : (
                        <>
                          {NAME_RE.test(site.name) && (
                            <Link
                              href={`/sites/${encodeURIComponent(site.name)}`}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
                            >
                              <span>Files &amp; Deploy</span>
                            </Link>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(site);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition"
                          >
                            <IconTrash className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Site Modal */}
      <Modal
        open={createOpen}
        title="Create Web App & Virtual Host"
        subtitle="Creates Apache vhost, site directory, optional matching SQLite database, and Cloudflare Tunnel route."
        onClose={() => setCreateOpen(false)}
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {createError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {createError}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Site Name
            </label>
            <input
              type="text"
              autoFocus
              required
              placeholder="e.g. blog"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
            {nameError && <p className="mt-1 text-xs text-rose-400">{nameError}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Web App Framework / Type
            </label>
            <select
              value={siteType}
              onChange={(e) => setSiteType(e.target.value as SiteType)}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
            >
              {SITE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FRAMEWORK_PRESETS[t].label} — {FRAMEWORK_PRESETS[t].summary}
                </option>
              ))}
            </select>
            <div className="mt-1.5 rounded-md border border-borderline bg-canvas px-3 py-2 text-[11px] font-mono text-slate-400">
              Auto-build pipeline: <span className="text-slate-200">{selectedPreset.pipeline}</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Custom Domain (optional)
            </label>
            <input
              type="text"
              placeholder={`${name || '<name>'}.${baseDomain}`}
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
            {domainError ? (
              <p className="mt-1 text-xs text-rose-400">{domainError}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                Leave blank to use{' '}
                <span className="font-mono text-slate-300">
                  {name || '<name>'}.{baseDomain}
                </span>
              </p>
            )}
          </div>

          {selectedPreset.hasPort && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Internal App Port (optional)
              </label>
              <input
                type="number"
                min={3001}
                max={39999}
                placeholder="Auto-assign (3100+)"
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">
                Creates <span className="font-mono">/etc/systemd/system/app-{name || '<name>'}.service</span> and excludes <span className="font-mono">/db.php</span> from ProxyPass.
              </p>
            </div>
          )}

          <div className="space-y-2.5 rounded-lg border border-borderline bg-canvas p-3">
            <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={createDb}
                onChange={(e) => setCreateDb(e.target.checked)}
                className="mt-0.5 rounded border-borderline bg-surface text-accent focus:ring-accent"
              />
              <span>
                Automatically create matching SQLite database (<span className="font-mono">/srv/db/{name || '<name>'}/data.sqlite</span>) and seed <span className="font-mono">.env</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enableWatch}
                onChange={(e) => setEnableWatch(e.target.checked)}
                className="mt-0.5 rounded border-borderline bg-surface text-accent focus:ring-accent"
              />
              <span>
                Enable filesystem auto-watcher (automatically runs the {selectedPreset.label} build pipeline on SSH/SFTP file changes)
              </span>
            </label>
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
              disabled={!isFormValid || creating}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {creating ? 'Provisioning...' : 'Create Site'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reveal-Once Auto-Created Database API Key Modal */}
      <RevealKeyModal info={provisionedDb} onClose={() => setProvisionedDb(null)} />

      {/* Certbot TLS Modal */}
      <Modal
        open={certOpen}
        title="Provision Let's Encrypt Origin TLS Certificate"
        subtitle="Optional when behind Cloudflare Tunnel (which terminates HTTPS at the edge)."
        onClose={() => setCertOpen(false)}
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleCertSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Managed Domain
            </label>
            <input
              type="text"
              required
              value={certDomain}
              onChange={(e) => setCertDomain(e.target.value.toLowerCase())}
              placeholder={`app.${baseDomain}`}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={certDryRun}
              onChange={(e) => setCertDryRun(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent focus:ring-accent"
            />
            <span>Run with --dry-run (test validation without saving certificates)</span>
          </label>

          {certResult && (
            <div className="space-y-2">
              <StatusBadge
                tone={certResult.ok ? 'green' : 'red'}
                label={certResult.ok ? 'Certbot Succeeded' : 'Certbot Failed'}
                dot
              />
              <pre className="max-h-56 overflow-auto rounded-lg border border-borderline bg-canvas p-3 font-mono text-[11px] text-slate-300 whitespace-pre-wrap">
                {[certResult.stdout, certResult.stderr].filter(Boolean).join('\n') || 'No output'}
              </pre>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCertOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={certRunning || !DOMAIN_RE.test(certDomain.trim())}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {certRunning ? 'Running Certbot...' : certDryRun ? 'Test Dry Run' : 'Issue Certificate'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Site Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        title="Archive Site"
        subtitle="Disables Apache virtual host and archives docroot to /srv/backups/sites/."
        onClose={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div className="space-y-4">
            {deleteError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
                {deleteError}
              </div>
            )}
            <p className="text-xs text-slate-300 leading-relaxed">
              Are you sure you want to disable{' '}
              <span className="font-mono font-semibold text-slate-100">
                {deleteTarget.serverName}
              </span>{' '}
              and archive <span className="font-mono">{deleteTarget.docroot}</span>?
              {deleteTarget.hasDb && (
                <span className="block mt-2 text-amber-300">
                  Note: SQLite data in /srv/db/{deleteTarget.name} will be preserved.
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDelete}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40 transition"
              >
                {deleting ? 'Archiving...' : 'Archive Site'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

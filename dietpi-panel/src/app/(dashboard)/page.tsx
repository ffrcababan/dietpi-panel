'use client';

import React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconDatabase,
  IconGlobe,
  IconPlus,
  IconServer,
  IconUser,
  IconUsers,
} from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher } from '@/lib/client-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { ActivityEntry } from '@/app/api/activity/route';
import type { PanelStats } from '@/app/api/stats/route';

export default function OverviewPage() {
  const { me } = usePanel();
  const isAdmin = me?.role === 'admin';

  const { data: stats, error: statsError } = useSWR<PanelStats>(
    '/api/stats',
    apiFetcher,
    { refreshInterval: 5000 }
  );

  // Only administrators fetch global agent activity logs
  const { data: activityData } = useSWR<{ entries: ActivityEntry[] }>(
    isAdmin ? '/api/activity?lines=25' : null,
    apiFetcher,
    { refreshInterval: 5000 }
  );

  const entries = activityData?.entries ?? [];
  const usedPct = stats?.disk?.fsUsedPercent ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
              {isAdmin ? 'Server Overview' : `Welcome, ${me?.displayName || me?.username || 'Developer'}`}
            </h1>
            {me && (
              <StatusBadge
                tone={isAdmin ? 'blue' : 'slate'}
                label={isAdmin ? 'Administrator' : 'Standard User'}
              />
            )}
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {isAdmin
              ? 'Live status across hosted sites, SQLite databases, users, and system services.'
              : 'Manage your provisioned web apps, private SQLite databases, and account security.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Link
              href="/users"
              className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
            >
              <IconUsers className="w-3.5 h-3.5" />
              <span>Manage Users</span>
            </Link>
          )}
          <Link
            href="/databases"
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>New Database</span>
          </Link>
          <Link
            href="/sites"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>New Site</span>
          </Link>
        </div>
      </div>

      {statsError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {statsError.message}
        </div>
      )}

      {/* Overview KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Link
          href="/sites"
          className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              {isAdmin ? 'Active Sites' : 'My Sites'}
            </span>
            <IconGlobe className="w-4 h-4 text-sky-400" />
          </div>
          <div className="mt-3 text-3xl font-semibold text-slate-100">
            {stats ? stats.siteCount : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
            {isAdmin ? 'Enabled Apache virtual hosts' : 'Web apps owned by your account'}
          </div>
        </Link>

        <Link
          href="/databases"
          className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              {isAdmin ? 'Databases' : 'My Databases'}
            </span>
            <IconDatabase className="w-4 h-4 text-accent" />
          </div>
          <div className="mt-3 text-3xl font-semibold text-slate-100">
            {stats ? stats.dbCount : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
            {isAdmin ? 'SQLite WAL instances in /srv/db' : 'Private WAL SQLite databases'}
          </div>
        </Link>

        {isAdmin ? (
          <Link
            href="/services"
            className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                {me?.apacheUnit === 'httpd' ? 'Apache (httpd)' : 'Apache2'}
              </span>
              <IconServer className="w-4 h-4 text-slate-400" />
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <span
                className={`h-3 w-3 rounded-full ${
                  stats === undefined
                    ? 'bg-slate-600'
                    : stats.apacheActive
                      ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]'
                      : 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.6)]'
                }`}
              />
              <span className="text-2xl font-semibold text-slate-100">
                {stats === undefined ? '—' : stats.apacheActive ? 'Active' : 'Stopped'}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
              Web server &amp; reverse proxy
            </div>
          </Link>
        ) : (
          <div className="rounded-xl border border-borderline bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Web Runtime
              </span>
              <IconServer className="w-4 h-4 text-slate-400" />
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <span
                className={`h-3 w-3 rounded-full ${
                  stats === undefined
                    ? 'bg-slate-600'
                    : stats.apacheActive
                      ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]'
                      : 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.6)]'
                }`}
              />
              <span className="text-2xl font-semibold text-slate-100">
                {stats === undefined ? '—' : stats.apacheActive ? 'Online' : 'Offline'}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Apache host routing status
            </div>
          </div>
        )}

        {isAdmin && stats?.disk ? (
          <div className="rounded-xl border border-borderline bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                /srv/db Disk Usage
              </span>
              <span className="text-xs font-mono text-slate-400">{usedPct}% vol</span>
            </div>
            <div className="mt-3 text-2xl font-semibold text-slate-100">
              {formatBytes(stats.disk.dbDirBytes)}
            </div>
            <div className="mt-2.5 h-1.5 w-full rounded-full bg-canvas overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  usedPct > 85 ? 'bg-rose-500' : 'bg-accent'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, usedPct))}%` }}
              />
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">
              {`${formatBytes(stats.disk.fsAvailBytes)} free of ${formatBytes(stats.disk.fsTotalBytes)}`}
            </div>
          </div>
        ) : (
          <Link
            href="/account"
            className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Account Security
              </span>
              <IconUser className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-3 text-lg font-semibold text-slate-100 truncate">
              @{me?.username || '—'}
            </div>
            <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
              {me?.totpEnabled ? '2FA Enabled' : '2FA Off'} · Update profile &amp; password
            </div>
          </Link>
        )}
      </div>

      {/* Admin Activity Feed vs User Workspace Quick Guide */}
      {isAdmin ? (
        <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
          <div className="flex items-center justify-between border-b border-borderline px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Recent Activity</h2>
              <p className="text-xs text-slate-400">
                Audit trail from /var/log/control-agent.log (refreshes every 5s)
              </p>
            </div>
            <Link
              href="/logs?unit=control-agent"
              className="text-xs font-medium text-accent hover:text-accent-hover"
            >
              Agent Journal
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-borderline bg-canvas/50 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Timestamp</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                  <th className="px-5 py-3 font-medium">Parameters</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-borderline">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-xs text-slate-500">
                      No administrative actions recorded yet.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry, idx) => (
                    <tr key={`${entry.timestamp}-${idx}`} className="hover:bg-elevated/40">
                      <td className="px-5 py-3 whitespace-nowrap font-mono text-xs text-slate-400">
                        {formatDateTime(entry.timestamp)}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap font-mono text-xs text-slate-200">
                        {entry.action}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-400">
                        {Object.keys(entry.params || {}).length > 0
                          ? JSON.stringify(entry.params)
                          : '—'}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <StatusBadge
                          tone={entry.ok ? 'green' : 'red'}
                          label={entry.ok ? 'OK' : 'FAIL'}
                          dot
                        />
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400 max-w-xs truncate">
                        {entry.detail || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Link
            href="/sites"
            className="rounded-xl border border-borderline bg-surface p-5 hover:border-accent/40 transition"
          >
            <div className="text-sm font-semibold text-slate-100">Deploy a Web App</div>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Create your own site (Laravel, React, Next.js, Node, Python, PHP, Static), upload archives or folders, and run preset builds.
            </p>
          </Link>
          <Link
            href="/databases"
            className="rounded-xl border border-borderline bg-surface p-5 hover:border-accent/40 transition"
          >
            <div className="text-sm font-semibold text-slate-100">Provision a Database</div>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Create private WAL-mode SQLite databases with isolated HTTP /db.php API endpoints scoped strictly to your account.
            </p>
          </Link>
          <Link
            href="/account"
            className="rounded-xl border border-borderline bg-surface p-5 hover:border-accent/40 transition"
          >
            <div className="text-sm font-semibold text-slate-100">Manage Account &amp; Security</div>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Update your display name, email, username, password, and two-factor authenticator settings anytime.
            </p>
          </Link>
        </div>
      )}
    </div>
  );
}

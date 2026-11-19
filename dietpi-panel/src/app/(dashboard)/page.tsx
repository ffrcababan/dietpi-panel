'use client';

import React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconDatabase,
  IconGlobe,
  IconServer,
} from '@/components/Icons';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher } from '@/lib/client-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { ActivityEntry } from '@/app/api/activity/route';
import type { PanelStats } from '@/app/api/stats/route';

export default function OverviewPage() {
  const { data: stats, error: statsError } = useSWR<PanelStats>(
    '/api/stats',
    apiFetcher,
    { refreshInterval: 5000 }
  );
  const { data: activityData } = useSWR<{ entries: ActivityEntry[] }>(
    '/api/activity?lines=25',
    apiFetcher,
    { refreshInterval: 5000 }
  );

  const entries = activityData?.entries ?? [];
  const usedPct = stats?.disk?.fsUsedPercent ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Server Overview
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Live status across databases, Apache virtual hosts, and system services.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/databases"
            className="rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            New Database
          </Link>
          <Link
            href="/sites"
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
          >
            New Site
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
          href="/databases"
          className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Databases
            </span>
            <IconDatabase className="w-4 h-4 text-accent" />
          </div>
          <div className="mt-3 text-3xl font-semibold text-slate-100">
            {stats ? stats.dbCount : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
            SQLite WAL instances in /srv/db
          </div>
        </Link>

        <Link
          href="/sites"
          className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Active Sites
            </span>
            <IconGlobe className="w-4 h-4 text-sky-400" />
          </div>
          <div className="mt-3 text-3xl font-semibold text-slate-100">
            {stats ? stats.siteCount : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 group-hover:text-slate-400">
            Enabled Apache virtual hosts
          </div>
        </Link>

        <Link
          href="/services"
          className="group rounded-xl border border-borderline bg-surface p-5 hover:border-slate-600 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Apache2
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
            Web server & reverse proxy
          </div>
        </Link>

        <div className="rounded-xl border border-borderline bg-surface p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              /srv/db Disk Usage
            </span>
            <span className="text-xs font-mono text-slate-400">{usedPct}% vol</span>
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-100">
            {stats ? formatBytes(stats.disk.dbDirBytes) : '—'}
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
            {stats
              ? `${formatBytes(stats.disk.fsAvailBytes)} free of ${formatBytes(stats.disk.fsTotalBytes)}`
              : 'Calculating...'}
          </div>
        </div>
      </div>

      {/* Recent Activity Feed */}
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
    </div>
  );
}

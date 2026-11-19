'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { IconRefresh, IconTerminal } from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import type { ServiceRecord } from '@/app/api/services/route';

export default function ServicesPage() {
  const { me } = usePanel();
  const { data, error, mutate } = useSWR<{ services: ServiceRecord[] }>(
    '/api/services',
    apiFetcher,
    { refreshInterval: 5000 }
  );

  const [restartTarget, setRestartTarget] = useState<ServiceRecord | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [actionMsg, setActionMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const services = data?.services ?? [];

  const handleRestart = async () => {
    if (!me?.csrfToken || !restartTarget) return;
    setRestarting(true);
    setActionMsg(null);

    try {
      const res = await apiMutate<{
        result: { unit: string; restarted: boolean; scheduled: boolean };
      }>(
        `/api/services/${encodeURIComponent(restartTarget.unit)}/restart`,
        'POST',
        me.csrfToken
      );
      setActionMsg({
        ok: true,
        text: res.result.scheduled
          ? `Scheduled restart of ${res.result.unit}. Status will refresh shortly.`
          : `Restarted ${res.result.unit} successfully.`,
      });
      setRestartTarget(null);
      setTimeout(() => {
        void mutate();
      }, 1000);
    } catch (err) {
      setActionMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Service restart failed',
      });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          System Services
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Monitor and restart Apache, Control Agent, DietPi Panel, and custom systemd units in /etc/systemd/system.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}

      {actionMsg && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            actionMsg.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-borderline bg-canvas/50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Unit</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">State</th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderline">
              {services.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-500">
                    Loading system units...
                  </td>
                </tr>
              ) : (
                services.map((svc) => (
                  <tr key={svc.unit} className="hover:bg-elevated/40">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                            svc.active
                              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                              : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]'
                          }`}
                        />
                        <span className="font-mono font-medium text-slate-100">
                          {svc.unit}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge
                        tone={svc.active ? 'green' : 'red'}
                        label={svc.active ? 'Running' : 'Stopped'}
                      />
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-400">
                      {svc.activeState} ({svc.subState})
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-300">
                      {svc.description}
                    </td>
                    <td className="px-5 py-3.5 text-right whitespace-nowrap space-x-2">
                      <Link
                        href={`/logs?unit=${encodeURIComponent(svc.unit)}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
                      >
                        <IconTerminal className="w-3.5 h-3.5" />
                        <span>Logs</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => setRestartTarget(svc)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition"
                      >
                        <IconRefresh className="w-3.5 h-3.5" />
                        <span>Restart</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={Boolean(restartTarget)}
        title="Confirm Service Restart"
        subtitle="Executes systemctl restart via the privileged control agent."
        onClose={() => setRestartTarget(null)}
      >
        {restartTarget && (
          <div className="space-y-4">
            <p className="text-xs text-slate-300 leading-relaxed">
              Restart systemd unit{' '}
              <span className="font-mono font-semibold text-slate-100">
                {restartTarget.unit}.service
              </span>
              ?
              {(restartTarget.unit === 'control-agent' ||
                restartTarget.unit === 'dietpi-panel') && (
                <span className="block mt-2 text-amber-300">
                  Warning: restarting {restartTarget.unit} will briefly interrupt dashboard connectivity for 1–3 seconds.
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRestartTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restarting}
                onClick={handleRestart}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
              >
                {restarting ? 'Restarting...' : `Restart ${restartTarget.unit}`}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

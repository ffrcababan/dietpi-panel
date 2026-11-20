'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { IconCheck, IconCopy, IconRefresh } from '@/components/Icons';
import { apiFetcher } from '@/lib/client-api';
import { usePanel } from '@/components/PanelContext';
import type { ServiceRecord } from '@/app/api/services/route';

const LINE_OPTIONS = [50, 100, 250, 500, 1000];

function LogsViewerInner() {
  const { me } = usePanel();
  const defaultApacheUnit = me?.apacheUnit || 'apache2';
  const searchParams = useSearchParams();
  const initialUnit = searchParams.get('unit') || defaultApacheUnit;

  const [unit, setUnit] = useState(initialUnit);
  const [lines, setLines] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const paramUnit = searchParams.get('unit');
    if (paramUnit) {
      setUnit(paramUnit);
    }
  }, [searchParams]);

  const { data: servicesData } = useSWR<{ services: ServiceRecord[] }>(
    '/api/services',
    apiFetcher
  );

  const {
    data: logsData,
    error,
    isValidating,
    mutate,
  } = useSWR<{ unit: string; lines: number; output: string }>(
    `/api/logs?unit=${encodeURIComponent(unit)}&lines=${lines}`,
    apiFetcher,
    {
      refreshInterval: autoRefresh ? 5000 : 0,
    }
  );

  const serviceUnits = servicesData?.services?.map((s) => s.unit) ?? [
    defaultApacheUnit,
    'control-agent',
    'dietpi-panel',
  ];
  const unitOptions = Array.from(new Set([unit, ...serviceUnits]));

  const handleCopy = async () => {
    if (!logsData?.output) return;
    try {
      await navigator.clipboard.writeText(logsData.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logsData?.output]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Service Logs
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Inspect journalctl output for managed systemd units.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            aria-label="Select systemd unit"
            className="rounded-lg border border-borderline bg-surface px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
          >
            {unitOptions.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>

          <select
            value={lines}
            onChange={(e) => setLines(Number.parseInt(e.target.value, 10))}
            aria-label="Select line count"
            className="rounded-lg border border-borderline bg-surface px-3 py-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
          >
            {LINE_OPTIONS.map((count) => (
              <option key={count} value={count}>
                Last {count} lines
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent focus:ring-accent"
            />
            <span>Auto-refresh (5s)</span>
          </label>

          <button
            type="button"
            onClick={() => void mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            <IconRefresh className={`w-3.5 h-3.5 ${isValidating ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!logsData?.output}
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-40 transition"
          >
            {copied ? (
              <>
                <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <IconCopy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}

      <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-borderline bg-canvas/50 px-4 py-2.5 text-xs font-mono text-slate-400">
          <span>
            journalctl -u {unit} -n {lines} --no-pager -o short-iso
          </span>
          <span>{autoRefresh ? 'live' : 'paused'}</span>
        </div>
        <pre
          ref={preRef}
          className="h-[62vh] overflow-auto bg-[#080b10] p-4 font-mono text-xs leading-relaxed text-slate-200 whitespace-pre-wrap break-words"
        >
          {logsData
            ? logsData.output.trim() || 'No journal entries returned for this unit.'
            : 'Loading logs...'}
        </pre>
      </div>
    </div>
  );
}

export default function LogsPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-xl border border-borderline bg-surface p-6 text-sm text-slate-400">
          Loading log viewer...
        </div>
      }
    >
      <LogsViewerInner />
    </Suspense>
  );
}

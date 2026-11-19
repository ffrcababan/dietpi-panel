'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { IconCheck, IconCopy } from './Icons';
import { Modal } from './Modal';
import { formatTunnelSummary } from '@/lib/format';
import type { TunnelActionResult } from '@/lib/agent';

export interface ProvisionedDatabaseInfo {
  name: string;
  domain: string;
  dbPath: string;
  apiKey: string;
  envFile?: string | null;
  tunnel?: TunnelActionResult;
}

export function RevealKeyModal({
  info,
  onClose,
}: {
  info: ProvisionedDatabaseInfo | null;
  onClose: () => void;
}) {
  const [copiedField, setCopiedField] = useState<'key' | 'curl' | null>(null);

  const copyText = async (text: string, field: 'key' | 'curl') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Clipboard blocked in non-HTTPS test contexts
    }
  };

  const curlSnippet = info
    ? `curl -s -X POST https://${info.domain}/db.php \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: ${info.apiKey}" \\\n  -d '{"sql":"SELECT sqlite_version() AS version"}'`
    : '';

  const tunnelSummary = formatTunnelSummary(info?.tunnel);

  return (
    <Modal
      open={Boolean(info)}
      title="Database Provisioned — Copy Your API Key"
      subtitle="Store this key securely now. It is stored only in root-protected Apache config and will never be displayed again."
      onClose={onClose}
      maxWidthClass="max-w-xl"
    >
      {info && (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
            Reveal-once secret: closing this dialog permanently hides the API key.
          </div>

          {info.envFile && (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3.5 py-2 text-xs text-sky-200">
              Seeded <span className="font-mono">/var/www/{info.name}/{info.envFile}</span> with{' '}
              <span className="font-mono">{info.dbPath}</span> and API credentials.
            </div>
          )}

          {tunnelSummary && (
            <div
              className={`rounded-lg border px-3.5 py-2 text-xs ${
                tunnelSummary.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              }`}
            >
              {tunnelSummary.text}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-300">
                x-api-key for <span className="font-mono text-slate-100">{info.name}</span>
              </span>
              <button
                type="button"
                onClick={() => copyText(info.apiKey, 'key')}
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
              {info.apiKey}
            </div>
          </div>

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

          <div className="flex items-center justify-between gap-2 pt-2">
            <Link
              href={`/sites/${encodeURIComponent(info.name)}`}
              onClick={onClose}
              className="rounded-lg border border-borderline bg-elevated px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
            >
              Manage Site Files &amp; Deploy
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
            >
              I Have Saved the Key
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

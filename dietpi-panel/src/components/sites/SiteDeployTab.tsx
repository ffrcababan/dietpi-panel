'use client';

import React from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import type { SiteBuildRecord } from '@/lib/agent';
import { formatDateTime } from '@/lib/format';
import type { GitStatus } from '@/app/api/sites/[name]/git/route';

export const SiteDeployTab = React.memo(function SiteDeployTab({
  siteName,
  siteType,
  git,
  lastBuild,
  repoUrl,
  branch,
  gitAutoBuild,
  gitBusy,
  onChangeRepoUrl,
  onChangeBranch,
  onChangeGitAutoBuild,
  onGitAction,
}: {
  siteName: string;
  siteType: string;
  git?: GitStatus;
  lastBuild?: SiteBuildRecord | null;
  repoUrl: string;
  branch: string;
  gitAutoBuild: boolean;
  gitBusy: boolean;
  onChangeRepoUrl: (val: string) => void;
  onChangeBranch: (val: string) => void;
  onChangeGitAutoBuild: (val: boolean) => void;
  onGitAction: (action: 'clone' | 'pull') => void;
}) {
  return (
    <div className="space-y-6">
      {/* Git Clone / Pull */}
      <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Git Deployment</h2>
            <p className="text-xs text-slate-400">
              Clone or pull your repository directly into{' '}
              <span className="font-mono">/var/www/{siteName}</span> (preserving{' '}
              <span className="font-mono">.env</span> and{' '}
              <span className="font-mono">/db.php</span>).
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
                  onChange={(e) => onChangeGitAutoBuild(e.target.checked)}
                  className="rounded border-borderline bg-canvas text-accent"
                />
                <span>Auto-run preset build after pull</span>
              </label>
              <button
                type="button"
                disabled={gitBusy}
                onClick={() => onGitAction('pull')}
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
              onGitAction('clone');
            }}
            className="grid grid-cols-1 gap-3 sm:grid-cols-12"
          >
            <div className="sm:col-span-7">
              <input
                type="text"
                required
                placeholder="https://github.com/user/repo.git"
                value={repoUrl}
                onChange={(e) => onChangeRepoUrl(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>
            <div className="sm:col-span-3">
              <input
                type="text"
                placeholder="Branch (default)"
                value={branch}
                onChange={(e) => onChangeBranch(e.target.value)}
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
  );
});

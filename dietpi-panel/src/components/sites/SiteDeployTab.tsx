'use client';

import React, { useState } from 'react';
import { IconKey } from '@/components/Icons';
import { PasswordInput } from '@/components/PasswordInput';
import { StatusBadge } from '@/components/StatusBadge';
import type { SiteBuildRecord } from '@/lib/agent';
import { formatDateTime } from '@/lib/format';
import type { GitStatus } from '@/app/api/sites/[name]/git/route';

function GitPatAuthFields({
  mode,
  gitUsername,
  gitToken,
  saveGitToken,
  savedUsername,
  hasSavedToken,
  disabled,
  onChangeGitUsername,
  onChangeGitToken,
  onChangeSaveGitToken,
}: {
  mode: 'clone' | 'pull';
  gitUsername: string;
  gitToken: string;
  saveGitToken: boolean;
  savedUsername?: string;
  hasSavedToken?: boolean;
  disabled: boolean;
  onChangeGitUsername: (val: string) => void;
  onChangeGitToken: (val: string) => void;
  onChangeSaveGitToken: (val: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-borderline bg-canvas/70 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-slate-200 flex items-center gap-1.5">
          <IconKey className="w-3.5 h-3.5 text-accent" />
          <span>
            {mode === 'clone'
              ? 'Private Repository Authentication (HTTPS PAT)'
              : 'Supply or Replace Personal Access Token (HTTPS)'}
          </span>
        </div>
        <span className="text-[11px] text-slate-400">
          GitHub: <code className="text-slate-300">x-access-token</code> · GitLab:{' '}
          <code className="text-slate-300">oauth2</code> · Bitbucket / Gitea: username
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
        <div className="sm:col-span-4 space-y-1">
          <label className="block text-[11px] font-medium text-slate-400">
            Git Username (optional)
          </label>
          <input
            type="text"
            autoComplete="username"
            disabled={disabled}
            placeholder={savedUsername || 'x-access-token'}
            value={gitUsername}
            onChange={(e) => onChangeGitUsername(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <div className="sm:col-span-8 space-y-1">
          <label className="block text-[11px] font-medium text-slate-400">
            Personal Access Token
          </label>
          <PasswordInput
            autoComplete="new-password"
            disabled={disabled}
            placeholder={
              mode === 'pull' && hasSavedToken
                ? 'Leave blank to use saved PAT, or paste a new token'
                : 'ghp_... / glpat-... / personal access token'
            }
            value={gitToken}
            onChange={(e) => onChangeGitToken(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={saveGitToken}
            onChange={(e) => onChangeSaveGitToken(e.target.checked)}
            className="rounded border-borderline bg-canvas text-accent"
          />
          <span>
            {mode === 'clone'
              ? 'Remember token securely on server for future Git Pulls'
              : 'Save / update token securely on server for future pulls'}
          </span>
        </label>
        <span className="text-[11px] text-slate-500">
          Stored root-only (0600); never written to .git/config or logs.
        </span>
      </div>
    </div>
  );
}

export const SiteDeployTab = React.memo(function SiteDeployTab({
  siteName,
  siteType,
  git,
  lastBuild,
  repoUrl,
  branch,
  gitUsername,
  gitToken,
  saveGitToken,
  gitAutoBuild,
  gitBusy,
  onChangeRepoUrl,
  onChangeBranch,
  onChangeGitUsername,
  onChangeGitToken,
  onChangeSaveGitToken,
  onChangeGitAutoBuild,
  onGitAction,
}: {
  siteName: string;
  siteType: string;
  git?: GitStatus;
  lastBuild?: SiteBuildRecord | null;
  repoUrl: string;
  branch: string;
  gitUsername: string;
  gitToken: string;
  saveGitToken: boolean;
  gitAutoBuild: boolean;
  gitBusy: boolean;
  onChangeRepoUrl: (val: string) => void;
  onChangeBranch: (val: string) => void;
  onChangeGitUsername: (val: string) => void;
  onChangeGitToken: (val: string) => void;
  onChangeSaveGitToken: (val: boolean) => void;
  onChangeGitAutoBuild: (val: boolean) => void;
  onGitAction: (action: 'clone' | 'pull' | 'clearToken') => void;
}) {
  const [showCloneAuth, setShowCloneAuth] = useState(false);
  const [showPullAuth, setShowPullAuth] = useState(false);
  const cloneAuthOpen = showCloneAuth || gitToken.length > 0 || gitUsername.length > 0;
  const pullAuthOpen = showPullAuth || gitToken.length > 0 || gitUsername.length > 0;
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
          <div className="flex flex-wrap items-center gap-2">
            {git?.initialized && (
              <StatusBadge
                tone={git.hasSavedToken ? 'blue' : 'slate'}
                label={git.hasSavedToken ? 'PAT Saved' : 'No Saved PAT'}
              />
            )}
            <StatusBadge
              tone={git?.initialized ? 'green' : 'slate'}
              label={git?.initialized ? `Branch: ${git.branch || 'main'}` : 'Not initialized'}
              dot
            />
          </div>
        </div>

        {git?.initialized ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-borderline bg-canvas p-3 font-mono text-xs text-slate-300 space-y-1">
              <div>
                Remote: <span className="text-slate-100">{git.remote}</span>
              </div>
              {git.hasSavedToken && (
                <div>
                  Auth:{' '}
                  <span className="text-sky-300">Saved HTTPS PAT</span>
                  {git.savedUsername && (
                    <>
                      {' '}
                      (<span className="text-slate-200">{git.savedUsername}</span>)
                    </>
                  )}
                </div>
              )}
              {git.status && (
                <div className="text-amber-300 whitespace-pre-wrap">
                  Working tree:\n{git.status}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4">
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
                  onClick={() => setShowPullAuth((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-50 transition"
                >
                  <IconKey className="w-3.5 h-3.5" />
                  <span>
                    {pullAuthOpen
                      ? 'Hide PAT Options'
                      : git.hasSavedToken
                        ? 'Replace PAT'
                        : 'Supply PAT'}
                  </span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {git.hasSavedToken && (
                  <button
                    type="button"
                    disabled={gitBusy}
                    onClick={() => onGitAction('clearToken')}
                    className="rounded-lg border border-borderline px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 hover:text-rose-300 disabled:opacity-50 transition"
                  >
                    Clear Saved Token
                  </button>
                )}
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

            {pullAuthOpen && (
              <GitPatAuthFields
                mode="pull"
                gitUsername={gitUsername}
                gitToken={gitToken}
                saveGitToken={saveGitToken}
                savedUsername={git.savedUsername}
                hasSavedToken={git.hasSavedToken}
                disabled={gitBusy}
                onChangeGitUsername={onChangeGitUsername}
                onChangeGitToken={onChangeGitToken}
                onChangeSaveGitToken={onChangeSaveGitToken}
              />
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onGitAction('clone');
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-7">
                <input
                  type="text"
                  required
                  disabled={gitBusy}
                  placeholder="https://github.com/user/repo.git"
                  value={repoUrl}
                  onChange={(e) => onChangeRepoUrl(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none disabled:opacity-50"
                />
              </div>
              <div className="sm:col-span-3">
                <input
                  type="text"
                  disabled={gitBusy}
                  placeholder="Branch (default)"
                  value={branch}
                  onChange={(e) => onChangeBranch(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none disabled:opacity-50"
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
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                disabled={gitBusy}
                onClick={() => setShowCloneAuth((prev) => !prev)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-50 transition"
              >
                <IconKey className="w-3.5 h-3.5" />
                <span>
                  {cloneAuthOpen
                    ? 'Hide Private Repo Auth (PAT)'
                    : 'Private Repo? Use Personal Access Token (PAT)'}
                </span>
              </button>

              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={gitBusy}
                  checked={gitAutoBuild}
                  onChange={(e) => onChangeGitAutoBuild(e.target.checked)}
                  className="rounded border-borderline bg-canvas text-accent"
                />
                <span>Auto-run preset build after clone</span>
              </label>
            </div>

            {cloneAuthOpen && (
              <GitPatAuthFields
                mode="clone"
                gitUsername={gitUsername}
                gitToken={gitToken}
                saveGitToken={saveGitToken}
                savedUsername={git?.savedUsername}
                hasSavedToken={git?.hasSavedToken}
                disabled={gitBusy}
                onChangeGitUsername={onChangeGitUsername}
                onChangeGitToken={onChangeGitToken}
                onChangeSaveGitToken={onChangeSaveGitToken}
              />
            )}
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

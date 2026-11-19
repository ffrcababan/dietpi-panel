'use client';

import React, { useState } from 'react';
import { IconCheck, IconCopy, IconLock, IconShield } from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { apiMutate } from '@/lib/client-api';

interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
  setupToken: string;
}

export default function SettingsPage() {
  const { me, refreshMe } = usePanel();

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 2FA state
  const [setupData, setSetupData] = useState<TwoFactorSetup | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [twoFaBusy, setTwoFaBusy] = useState(false);
  const [twoFaMsg, setTwoFaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken) return;
    setPwMessage(null);

    if (newPassword.length < 12) {
      setPwMessage({ ok: false, text: 'New password must be at least 12 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMessage({ ok: false, text: 'New passwords do not match.' });
      return;
    }

    setPwSaving(true);
    try {
      await apiMutate('/api/auth/password', 'POST', me.csrfToken, {
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refreshMe();
      setPwMessage({ ok: true, text: 'Administrator password updated successfully.' });
    } catch (err) {
      setPwMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update password',
      });
    } finally {
      setPwSaving(false);
    }
  };

  const handleStart2faSetup = async () => {
    if (!me?.csrfToken) return;
    setTwoFaBusy(true);
    setTwoFaMsg(null);
    try {
      const res = await apiMutate<TwoFactorSetup>(
        '/api/auth/2fa',
        'POST',
        me.csrfToken,
        { action: 'setup' }
      );
      setSetupData(res);
      setVerifyCode('');
    } catch (err) {
      setTwoFaMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to generate 2FA secret',
      });
    } finally {
      setTwoFaBusy(false);
    }
  };

  const handleEnable2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !setupData) return;
    setTwoFaBusy(true);
    setTwoFaMsg(null);

    try {
      await apiMutate('/api/auth/2fa', 'POST', me.csrfToken, {
        action: 'enable',
        setupToken: setupData.setupToken,
        code: verifyCode,
      });
      setSetupData(null);
      setVerifyCode('');
      await refreshMe();
      setTwoFaMsg({ ok: true, text: 'Two-factor authentication enabled.' });
    } catch (err) {
      setTwoFaMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to verify TOTP code',
      });
    } finally {
      setTwoFaBusy(false);
    }
  };

  const handleDisable2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken) return;
    setTwoFaBusy(true);
    setTwoFaMsg(null);

    try {
      await apiMutate('/api/auth/2fa', 'DELETE', me.csrfToken, {
        currentPassword: disablePw,
        code: disableCode,
      });
      setDisablePw('');
      setDisableCode('');
      await refreshMe();
      setTwoFaMsg({ ok: true, text: 'Two-factor authentication disabled.' });
    } catch (err) {
      setTwoFaMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to disable 2FA',
      });
    } finally {
      setTwoFaBusy(false);
    }
  };

  const copySecret = async () => {
    if (!setupData?.secret) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Settings &amp; Security
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage administrator password, TOTP two-factor authentication, and control agent status.
        </p>
      </div>

      {me?.mustChangePassword && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 text-sm text-amber-200">
          Initial login requirement: please set a new administrator password (12+ characters) to unlock all panel features.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Change Password */}
        <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <IconLock className="w-4 h-4 text-accent" />
            <h2 className="text-base font-semibold text-slate-100">Change Password</h2>
          </div>

          {pwMessage && (
            <div
              className={`rounded-lg border px-3.5 py-2 text-xs ${
                pwMessage.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              {pwMessage.text}
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Current Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                New Password (min 12 characters)
              </label>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={pwSaving || !me?.csrfToken}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {pwSaving ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        </section>

        {/* TOTP 2FA */}
        <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <IconShield className="w-4 h-4 text-accent" />
              <h2 className="text-base font-semibold text-slate-100">
                Two-Factor Authentication (TOTP)
              </h2>
            </div>
            <StatusBadge
              tone={me?.totpEnabled ? 'green' : 'amber'}
              label={me?.totpEnabled ? 'Enabled' : 'Disabled'}
              dot
            />
          </div>

          {twoFaMsg && (
            <div
              className={`rounded-lg border px-3.5 py-2 text-xs ${
                twoFaMsg.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              {twoFaMsg.text}
            </div>
          )}

          {me?.mustChangePassword ? (
            <p className="text-xs text-slate-400">
              Change your initial password first to configure 2FA.
            </p>
          ) : me?.totpEnabled ? (
            <form onSubmit={handleDisable2fa} className="space-y-3.5">
              <p className="text-xs text-slate-400">
                TOTP 2FA is active for <span className="font-mono text-slate-200">{me.username}</span>. Enter your password and a current 6-digit code to disable it.
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  required
                  value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  6-Digit Authenticator Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  placeholder="000000"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm tracking-widest text-slate-100 focus:border-accent focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={twoFaBusy || disableCode.length !== 6}
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/20 disabled:opacity-50 transition"
              >
                {twoFaBusy ? 'Disabling...' : 'Disable 2FA'}
              </button>
            </form>
          ) : setupData ? (
            <form onSubmit={handleEnable2fa} className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={setupData.qrDataUrl}
                  alt="TOTP QR Code"
                  width={160}
                  height={160}
                  className="rounded-lg border border-borderline bg-slate-100 p-1.5 shrink-0"
                />
                <div className="space-y-2 min-w-0 flex-1">
                  <p className="text-xs text-slate-300">
                    Scan this QR code with Bitwarden, 1Password, Google Authenticator, or Aegis.
                  </p>
                  <div className="text-[11px] text-slate-400">Manual Base32 key:</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md border border-borderline bg-canvas px-2.5 py-1.5 font-mono text-[11px] text-emerald-300 break-all">
                      {setupData.secret}
                    </code>
                    <button
                      type="button"
                      onClick={copySecret}
                      className="rounded-md border border-borderline bg-elevated p-1.5 text-slate-300 hover:text-white"
                      title="Copy secret"
                    >
                      {copiedSecret ? (
                        <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <IconCopy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Enter 6-digit confirmation code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  placeholder="000000"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm tracking-widest text-slate-100 focus:border-accent focus:outline-none"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSetupData(null)}
                  className="rounded-lg border border-borderline bg-elevated px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={twoFaBusy || verifyCode.length !== 6}
                  className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
                >
                  {twoFaBusy ? 'Activating...' : 'Verify & Enable 2FA'}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-400 leading-relaxed">
                Add RFC 6238 TOTP two-factor authentication using any standard authenticator app. Pure Node.js crypto implementation with zero third-party auth servers.
              </p>
              <button
                type="button"
                disabled={twoFaBusy}
                onClick={handleStart2faSetup}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
              >
                {twoFaBusy ? 'Generating...' : 'Configure 2FA'}
              </button>
            </div>
          )}
        </section>
      </div>

      {/* Control Agent Connection Diagnostics */}
      <section className="rounded-xl border border-borderline bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Control Agent &amp; Architecture Status
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Unprivileged panel UI communicates exclusively via authenticated Unix domain socket.
            </p>
          </div>
          <StatusBadge
            tone={me?.agentConnected ? 'green' : 'red'}
            label={me?.agentConnected ? 'Socket Connected' : 'Socket Disconnected'}
            dot
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 text-xs font-mono">
          <div className="rounded-lg border border-borderline bg-canvas p-3">
            <div className="text-slate-500">Unix Socket</div>
            <div className="mt-1 text-slate-200">/run/control-agent.sock</div>
          </div>
          <div className="rounded-lg border border-borderline bg-canvas p-3">
            <div className="text-slate-500">Base Domain</div>
            <div className="mt-1 text-slate-200">{me?.baseDomain || '—'}</div>
          </div>
          <div className="rounded-lg border border-borderline bg-canvas p-3">
            <div className="text-slate-500">Panel Auth DB</div>
            <div className="mt-1 text-slate-200">/srv/db/_panel/panel.sqlite</div>
          </div>
        </div>
      </section>
    </div>
  );
}

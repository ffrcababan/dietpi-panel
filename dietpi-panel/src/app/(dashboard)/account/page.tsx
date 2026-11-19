'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  IconCheck,
  IconCopy,
  IconDatabase,
  IconGlobe,
  IconLock,
  IconShield,
  IconUser,
} from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { PasswordInput } from '@/components/PasswordInput';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import { formatDateTime } from '@/lib/format';
import { USERNAME_RE } from '@/lib/validation';

interface AccountDetails {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: 'admin' | 'user';
  totpEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  siteCount: number;
  dbCount: number;
}

interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
  setupToken: string;
}

function getPasswordStrength(pw: string): {
  score: number;
  label: string;
  barClass: string;
} {
  if (!pw) return { score: 0, label: '', barClass: 'bg-slate-700' };
  let score = 0;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) score += 1;
  if (score <= 1) return { score: 1, label: 'Weak (need 12+ chars)', barClass: 'bg-rose-500' };
  if (score === 2) return { score: 2, label: 'Fair', barClass: 'bg-amber-500' };
  if (score === 3) return { score: 3, label: 'Good', barClass: 'bg-sky-500' };
  return { score: 4, label: 'Strong', barClass: 'bg-emerald-500' };
}

export default function AccountPage() {
  const router = useRouter();
  const { me, refreshMe } = usePanel();
  const { data, mutate: mutateAccount } = useSWR<{ account: AccountDetails }>(
    '/api/auth/account',
    apiFetcher,
    { keepPreviousData: true }
  );

  const account = data?.account;

  // Profile form state
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [profilePw, setProfilePw] = useState('');
  const [profileInitialized, setProfileInitialized] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!profileInitialized && (account || me)) {
      setDisplayName(account?.displayName ?? me?.displayName ?? '');
      setEmail(account?.email ?? me?.email ?? '');
      setUsername(account?.username ?? me?.username ?? '');
      setProfileInitialized(true);
    }
  }, [account, me, profileInitialized]);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 2FA state
  const [setupData, setSetupData] = useState<TwoFactorSetup | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [twoFaBusy, setTwoFaBusy] = useState(false);
  const [twoFaMsg, setTwoFaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const currentUsername = account?.username ?? me?.username ?? '';
  const usernameChanged =
    username.trim().toLowerCase() !== currentUsername.toLowerCase();
  const strength = getPasswordStrength(newPassword);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken) return;
    setProfileMsg(null);

    const trimmedUser = username.trim().toLowerCase();
    if (usernameChanged && !USERNAME_RE.test(trimmedUser)) {
      setProfileMsg({
        ok: false,
        text: 'Username must be 3-32 lowercase chars starting with a letter.',
      });
      return;
    }

    setProfileSaving(true);
    try {
      const res = await apiMutate<{
        ok: boolean;
        csrfToken?: string;
        account: {
          username: string;
          displayName: string;
          email: string;
        };
      }>('/api/auth/account', 'PATCH', me.csrfToken, {
        displayName,
        email,
        username: trimmedUser,
        currentPassword: usernameChanged ? profilePw : undefined,
      });

      setProfilePw('');
      await refreshMe({
        ...me,
        username: res.account.username,
        displayName: res.account.displayName,
        email: res.account.email,
        csrfToken: res.csrfToken || me.csrfToken,
      });
      await mutateAccount();
      setProfileMsg({ ok: true, text: 'Account profile saved.' });
    } catch (err) {
      setProfileMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to save profile',
      });
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken) return;
    setPwMsg(null);

    if (newPassword.length < 12) {
      setPwMsg({ ok: false, text: 'New password must be at least 12 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMsg({ ok: false, text: 'New passwords do not match.' });
      return;
    }

    setPwSaving(true);
    try {
      const res = await apiMutate<{ ok: boolean; csrfToken?: string }>(
        '/api/auth/password',
        'POST',
        me.csrfToken,
        {
          currentPassword,
          newPassword,
        }
      );
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refreshMe({
        ...me,
        mustChangePassword: false,
        csrfToken: res.csrfToken || me.csrfToken,
      });
      await mutateAccount();
      router.refresh();
      setPwMsg({ ok: true, text: 'Password updated successfully.' });
    } catch (err) {
      setPwMsg({
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
      await Promise.all([refreshMe(), mutateAccount()]);
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
      await Promise.all([refreshMe(), mutateAccount()]);
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

  const initials = (account?.displayName || currentUsername || 'U')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="space-y-6">
      {/* Header Profile Summary */}
      <div className="rounded-2xl border border-borderline bg-surface p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 border border-accent/40 font-mono text-base font-bold text-accent shrink-0">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-slate-100 truncate">
                {account?.displayName || me?.displayName || currentUsername || 'My Account'}
              </h1>
              <StatusBadge
                tone={me?.role === 'admin' ? 'blue' : 'slate'}
                label={me?.role === 'admin' ? 'Administrator' : 'User'}
              />
              <StatusBadge
                tone={me?.totpEnabled ? 'green' : 'amber'}
                label={me?.totpEnabled ? '2FA On' : '2FA Off'}
                dot
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400 font-mono">
              <span>@{currentUsername}</span>
              {account?.email && <span>· {account.email}</span>}
              {account?.createdAt && <span>· Joined {formatDateTime(account.createdAt)}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/sites"
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-canvas px-3 py-2 text-xs text-slate-200 hover:border-slate-500 transition"
          >
            <IconGlobe className="w-3.5 h-3.5 text-sky-400" />
            <span>{account?.siteCount ?? 0} Sites</span>
          </Link>
          <Link
            href="/databases"
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-canvas px-3 py-2 text-xs text-slate-200 hover:border-slate-500 transition"
          >
            <IconDatabase className="w-3.5 h-3.5 text-accent" />
            <span>{account?.dbCount ?? 0} DBs</span>
          </Link>
        </div>
      </div>

      {me?.mustChangePassword && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 text-sm text-amber-200">
          Security notice: please set a new password (12+ characters) below to unlock all panel features.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Account Profile Card */}
        <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <IconUser className="w-4 h-4 text-accent" />
            <h2 className="text-base font-semibold text-slate-100">Account Information</h2>
          </div>

          {profileMsg && (
            <div
              className={`rounded-lg border px-3.5 py-2 text-xs ${
                profileMsg.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              {profileMsg.text}
            </div>
          )}

          <form onSubmit={handleProfileSave} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                maxLength={64}
                placeholder="e.g. Jane Doe"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Email Address (optional)
              </label>
              <input
                type="email"
                maxLength={120}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Username
              </label>
              <input
                type="text"
                disabled={currentUsername === 'admin'}
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none disabled:opacity-60"
              />
              {currentUsername === 'admin' && (
                <p className="mt-1 text-[11px] text-slate-500">
                  The primary &ldquo;admin&rdquo; username is locked to preserve installer idempotency.
                </p>
              )}
            </div>

            {usernameChanged && currentUsername !== 'admin' && (
              <div>
                <label className="block text-xs font-medium text-amber-300 mb-1">
                  Confirm Current Password to Rename Username
                </label>
                <PasswordInput
                  required
                  autoComplete="current-password"
                  value={profilePw}
                  onChange={(e) => setProfilePw(e.target.value)}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={profileSaving || !me?.csrfToken}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {profileSaving ? 'Saving...' : 'Save Account Info'}
            </button>
          </form>
        </section>

        {/* Change Password Card */}
        <section className="rounded-xl border border-borderline bg-surface p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <IconLock className="w-4 h-4 text-accent" />
            <h2 className="text-base font-semibold text-slate-100">Change Password</h2>
          </div>

          {pwMsg && (
            <div
              className={`rounded-lg border px-3.5 py-2 text-xs ${
                pwMsg.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              {pwMsg.text}
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Current Password
              </label>
              <PasswordInput
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                New Password (min 12 characters)
              </label>
              <PasswordInput
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              {newPassword && (
                <div className="mt-1.5 space-y-1">
                  <div className="grid grid-cols-4 gap-1 h-1">
                    {[1, 2, 3, 4].map((idx) => (
                      <div
                        key={idx}
                        className={`rounded-full ${
                          idx <= strength.score ? strength.barClass : 'bg-elevated'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="text-[11px] text-slate-400">{strength.label}</div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Confirm New Password
              </label>
              <PasswordInput
                autoComplete="new-password"
                required
                minLength={12}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
      </div>

      {/* TOTP 2FA Section */}
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
            Update your temporary password above first to configure 2FA.
          </p>
        ) : me?.totpEnabled ? (
          <form onSubmit={handleDisable2fa} className="max-w-md space-y-3.5">
            <p className="text-xs text-slate-400">
              TOTP 2FA is active for <span className="font-mono text-slate-200">@{currentUsername}</span>. Enter your password and a 6-digit authenticator code to disable it.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Current Password
              </label>
              <PasswordInput
                required
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
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
          <form onSubmit={handleEnable2fa} className="max-w-xl space-y-4">
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
              Protect your account with RFC 6238 TOTP two-factor authentication using any standard authenticator app.
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
  );
}

'use client';

import React, { useState } from 'react';
import { IconLock, IconShield } from '@/components/Icons';
import { PasswordInput } from '@/components/PasswordInput';

export default function LoginPage() {
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        requiresTotp?: boolean;
        mustChangePassword?: boolean;
      };

      if (!res.ok) {
        setError(data.error || 'Authentication failed');
        return;
      }

      if (data.requiresTotp) {
        setStep('totp');
        setTotpCode('');
        return;
      }

      window.location.assign(data.mustChangePassword ? '/account' : '/');
    } catch {
      setError('Unable to reach server');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        mustChangePassword?: boolean;
      };

      if (!res.ok) {
        setError(data.error || 'Invalid 2FA code');
        return;
      }

      window.location.assign(data.mustChangePassword ? '/account' : '/');
    } catch {
      setError('Unable to verify 2FA code');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-canvas">
      <div className="w-full max-w-sm rounded-2xl border border-borderline bg-surface p-7 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 border border-accent/40 text-accent">
            <IconShield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">DietPi Panel</h1>
            <p className="text-xs text-slate-400">
              {step === 'password'
                ? 'Sign in to manage your server'
                : 'Enter your 6-digit authenticator code'}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            {error}
          </div>
        )}

        {step === 'password' ? (
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                autoFocus
                required
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <PasswordInput
                autoComplete="current-password"
                required
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              <IconLock className="w-4 h-4" />
              <span>{submitting ? 'Signing in...' : 'Sign in'}</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleTotpSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Authenticator Code
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoFocus
                required
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2.5 text-center font-mono text-lg tracking-[0.35em] text-slate-100 placeholder-slate-600 focus:border-accent focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || totpCode.length !== 6}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {submitting ? 'Verifying...' : 'Verify 2FA'}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep('password');
                setError(null);
              }}
              className="w-full rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
            >
              Back to password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

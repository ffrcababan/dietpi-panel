'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  IconDatabase,
  IconGlobe,
  IconLock,
  IconShield,
  IconTrash,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import { PasswordInput } from '@/components/PasswordInput';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import { formatDateTime } from '@/lib/format';
import type { UserRole } from '@/lib/validation';
import type { UserRecord } from '@/app/api/users/route';

interface UserDetailResponse {
  user: UserRecord;
  owned: { sites: string[]; databases: string[] };
  availableSites: Array<{
    name: string;
    serverName: string;
    type: string;
    ownerUsername: string | null;
  }>;
  availableDatabases: Array<{
    name: string;
    domain: string;
    ownerUsername: string | null;
  }>;
  transferTargets: Array<{
    id: number;
    username: string;
    displayName: string;
    role: UserRole;
  }>;
}

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { me } = usePanel();
  const userId = params.id;

  const { data, error, mutate } = useSWR<UserDetailResponse>(
    `/api/users/${encodeURIComponent(userId)}`,
    apiFetcher,
    { keepPreviousData: true }
  );

  const user = data?.user;
  const owned = data?.owned ?? { sites: [], databases: [] };
  const availableSites = data?.availableSites ?? [];
  const availableDatabases = data?.availableDatabases ?? [];

  const [initializedForId, setInitializedForId] = useState<number | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [isActive, setIsActive] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [assignSiteName, setAssignSiteName] = useState('');
  const [assignDbName, setAssignDbName] = useState('');
  const [resourceBusy, setResourceBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reassignToId, setReassignToId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (user && initializedForId !== user.id) {
      setUsername(user.username);
      setDisplayName(user.displayName);
      setEmail(user.email);
      setRole(user.role);
      setIsActive(user.isActive);
      setMustChangePassword(user.mustChangePassword);
      setNewPassword('');
      setInitializedForId(user.id);
    }
  }, [user, initializedForId]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !user) return;
    if (newPassword && newPassword.length < 12) {
      setBanner({ ok: false, text: 'New password must be at least 12 characters.' });
      return;
    }

    setSaving(true);
    setBanner(null);
    try {
      await apiMutate(`/api/users/${user.id}`, 'PATCH', me.csrfToken, {
        username: user.username === 'admin' ? undefined : username.trim().toLowerCase(),
        displayName: displayName.trim(),
        email: email.trim(),
        role,
        isActive,
        mustChangePassword,
        password: newPassword || undefined,
      });
      setNewPassword('');
      setBanner({ ok: true, text: 'User profile & credentials saved.' });
      await mutate();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update user',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset2fa = async () => {
    if (!me?.csrfToken || !user) return;
    setSaving(true);
    setBanner(null);
    try {
      await apiMutate(`/api/users/${user.id}`, 'PATCH', me.csrfToken, {
        clearTotp: true,
      });
      setBanner({ ok: true, text: `Reset 2FA for @${user.username}.` });
      await mutate();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to reset 2FA',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleOwnershipAction = async (
    action: 'assign' | 'unassign',
    resourceType: 'site' | 'database',
    resourceName: string
  ) => {
    if (!me?.csrfToken || !user || !resourceName) return;
    setResourceBusy(true);
    setBanner(null);
    try {
      await apiMutate(`/api/users/${user.id}`, 'POST', me.csrfToken, {
        action,
        resourceType,
        resourceName,
      });
      if (action === 'assign') {
        if (resourceType === 'site') setAssignSiteName('');
        else setAssignDbName('');
      }
      setBanner({
        ok: true,
        text: `${action === 'assign' ? 'Assigned' : 'Unassigned'} ${resourceType} "${resourceName}".`,
      });
      await mutate();
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Ownership update failed',
      });
    } finally {
      setResourceBusy(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!me?.csrfToken || !user) return;
    setDeleting(true);
    setBanner(null);
    try {
      await apiMutate(
        `/api/users/${user.id}`,
        'DELETE',
        me.csrfToken,
        reassignToId ? { reassignToUserId: Number.parseInt(reassignToId, 10) } : {}
      );
      router.push('/users');
    } catch (err) {
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to delete user',
      });
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (me && me.role !== 'admin') {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-6 text-sm text-rose-200">
        Administrator access is required.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb & Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link href="/users" className="hover:text-accent transition">
              Users
            </Link>
            <span>/</span>
            <span className="font-mono text-slate-200">
              @{user?.username || userId}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
              {user ? user.displayName || `@${user.username}` : 'Loading user...'}
            </h1>
            {user && (
              <>
                <StatusBadge
                  tone={user.role === 'admin' ? 'blue' : 'slate'}
                  label={user.role === 'admin' ? 'Admin' : 'User'}
                />
                <StatusBadge
                  tone={user.isActive ? 'green' : 'red'}
                  label={user.isActive ? 'Active' : 'Suspended'}
                  dot
                />
                <StatusBadge
                  tone={user.totpEnabled ? 'green' : 'slate'}
                  label={user.totpEnabled ? '2FA On' : '2FA Off'}
                />
              </>
            )}
          </div>
          {user && (
            <p className="mt-1 text-xs font-mono text-slate-400">
              @{user.username}
              {user.email ? ` · ${user.email}` : ''} · Joined {formatDateTime(user.createdAt)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {user?.totpEnabled && (
            <button
              type="button"
              disabled={saving}
              onClick={handleReset2fa}
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
            >
              Reset 2FA
            </button>
          )}
          {user && me?.id !== user.id && user.username !== 'admin' && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/20"
            >
              <IconTrash className="w-3.5 h-3.5" />
              <span>Delete User</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error.message}
        </div>
      )}

      {banner && (
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs ${
            banner.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-400 hover:text-white shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {user && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left: Profile & Credentials Form */}
          <form
            onSubmit={handleSaveProfile}
            className="lg:col-span-5 rounded-xl border border-borderline bg-surface p-6 space-y-4"
          >
            <div className="flex items-center gap-2">
              <IconLock className="w-4 h-4 text-accent" />
              <h2 className="text-base font-semibold text-slate-100">
                Profile &amp; Access Control
              </h2>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Username
              </label>
              <input
                type="text"
                required
                disabled={user.username === 'admin'}
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                maxLength={64}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Email Address
              </label>
              <input
                type="email"
                maxLength={120}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Role
              </label>
              <select
                value={role}
                disabled={user.username === 'admin' || me?.id === user.id}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none disabled:opacity-60"
              >
                <option value="user">User (Scoped Sites &amp; DBs)</option>
                <option value="admin">Administrator (Full System Control)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Set New Password (optional, min 12 chars)
              </label>
              <PasswordInput
                minLength={12}
                autoComplete="new-password"
                placeholder="Leave blank to keep existing"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            <div className="space-y-2 rounded-lg border border-borderline bg-canvas p-3">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={me?.id === user.id}
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="rounded border-borderline bg-surface text-accent"
                />
                <span>Account active (allow sign-in)</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mustChangePassword}
                  onChange={(e) => setMustChangePassword(e.target.checked)}
                  className="rounded border-borderline bg-surface text-accent"
                />
                <span>Require password change on next login</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              {saving ? 'Saving...' : 'Save User Settings'}
            </button>
          </form>

          {/* Right: Owned Sites & Databases + Assignment */}
          <div className="lg:col-span-7 space-y-6">
            {/* Owned Sites */}
            <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline px-5 py-4">
                <div className="flex items-center gap-2">
                  <IconGlobe className="w-4 h-4 text-sky-400" />
                  <h2 className="text-sm font-semibold text-slate-100">
                    Owned Sites ({owned.sites.length})
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={assignSiteName}
                    onChange={(e) => setAssignSiteName(e.target.value)}
                    className="rounded-lg border border-borderline bg-canvas px-2.5 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
                  >
                    <option value="">Assign existing site...</option>
                    {availableSites
                      .filter((s) => !owned.sites.includes(s.name))
                      .map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name} ({s.serverName})
                          {s.ownerUsername ? ` · currently @${s.ownerUsername}` : ' · unassigned'}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!assignSiteName || resourceBusy}
                    onClick={() => handleOwnershipAction('assign', 'site', assignSiteName)}
                    className="rounded-lg bg-elevated border border-borderline px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-accent disabled:opacity-40"
                  >
                    Assign
                  </button>
                </div>
              </div>

              <div className="divide-y divide-borderline">
                {owned.sites.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-slate-500">
                    No sites assigned to @{user.username}. When they create a site, ownership is assigned automatically.
                  </div>
                ) : (
                  owned.sites.map((siteName) => {
                    const meta = availableSites.find((s) => s.name === siteName);
                    return (
                      <div
                        key={siteName}
                        className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-elevated/40"
                      >
                        <div className="min-w-0">
                          <Link
                            href={`/sites/${encodeURIComponent(siteName)}`}
                            className="font-mono text-xs font-semibold text-slate-100 hover:text-accent"
                          >
                            {siteName}
                          </Link>
                          {meta && (
                            <div className="text-[11px] font-mono text-slate-500">
                              {meta.serverName} · {meta.type}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Link
                            href={`/sites/${encodeURIComponent(siteName)}`}
                            className="rounded-md border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                          >
                            Files
                          </Link>
                          <button
                            type="button"
                            disabled={resourceBusy}
                            onClick={() => handleOwnershipAction('unassign', 'site', siteName)}
                            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
                          >
                            Unassign
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Owned Databases */}
            <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline px-5 py-4">
                <div className="flex items-center gap-2">
                  <IconDatabase className="w-4 h-4 text-accent" />
                  <h2 className="text-sm font-semibold text-slate-100">
                    Owned Databases ({owned.databases.length})
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={assignDbName}
                    onChange={(e) => setAssignDbName(e.target.value)}
                    className="rounded-lg border border-borderline bg-canvas px-2.5 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
                  >
                    <option value="">Assign existing database...</option>
                    {availableDatabases
                      .filter((d) => !owned.databases.includes(d.name))
                      .map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                          {d.ownerUsername ? ` · currently @${d.ownerUsername}` : ' · unassigned'}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!assignDbName || resourceBusy}
                    onClick={() => handleOwnershipAction('assign', 'database', assignDbName)}
                    className="rounded-lg bg-elevated border border-borderline px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-accent disabled:opacity-40"
                  >
                    Assign
                  </button>
                </div>
              </div>

              <div className="divide-y divide-borderline">
                {owned.databases.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-slate-500">
                    No SQLite databases assigned to @{user.username}.
                  </div>
                ) : (
                  owned.databases.map((dbName) => {
                    const meta = availableDatabases.find((d) => d.name === dbName);
                    return (
                      <div
                        key={dbName}
                        className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-elevated/40"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-xs font-semibold text-slate-100">
                            {dbName}
                          </div>
                          {meta && (
                            <div className="text-[11px] font-mono text-slate-500">
                              https://{meta.domain}/db.php
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={resourceBusy}
                          onClick={() => handleOwnershipAction('unassign', 'database', dbName)}
                          className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 shrink-0"
                        >
                          Unassign
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Delete User Modal */}
      <Modal
        open={deleteOpen}
        title="Delete User Account"
        subtitle="Permanently removes this user account while preserving files & SQLite databases on disk."
        onClose={() => !deleting && setDeleteOpen(false)}
        badge={<IconShield className="w-4 h-4 text-rose-400" />}
      >
        {user && (
          <div className="space-y-4">
            <p className="text-xs text-slate-300">
              Delete <span className="font-mono font-semibold text-rose-300">@{user.username}</span>?
            </p>
            {(owned.sites.length > 0 || owned.databases.length > 0) && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Transfer Owned Resources To
                </label>
                <select
                  value={reassignToId}
                  onChange={(e) => setReassignToId(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
                >
                  <option value="">Unassign (Administrators only)</option>
                  {(data?.transferTargets ?? []).map((t) => (
                    <option key={t.id} value={String(t.id)}>
                      @{t.username} ({t.role})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteOpen(false)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDeleteUser}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

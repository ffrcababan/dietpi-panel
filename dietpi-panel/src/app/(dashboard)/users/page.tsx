'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconCheck,
  IconCopy,
  IconPlus,
  IconSearch,
  IconShield,
  IconTrash,
  IconUsers,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import { usePanel } from '@/components/PanelContext';
import { PasswordInput } from '@/components/PasswordInput';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import { formatDateTime } from '@/lib/format';
import { USERNAME_RE, type UserRole } from '@/lib/validation';
import type { UserRecord } from '@/app/api/users/route';

function generateStrongPassword(length = 16): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_+=';
  const all = upper + lower + digits + symbols;
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  const picks = [
    upper[arr[0] % upper.length],
    lower[arr[1] % lower.length],
    digits[arr[2] % digits.length],
    symbols[arr[3] % symbols.length],
  ];
  for (let i = 4; i < length; i += 1) {
    picks.push(all[arr[i] % all.length]);
  }
  return picks.join('');
}

export default function UsersPage() {
  const { me } = usePanel();
  const { data, error, mutate } = useSWR<{ users: UserRecord[] }>(
    '/api/users',
    apiFetcher,
    { refreshInterval: 10_000, keepPreviousData: true }
  );

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'user'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [cUsername, setCUsername] = useState('');
  const [cDisplayName, setCDisplayName] = useState('');
  const [cEmail, setCEmail] = useState('');
  const [cRole, setCRole] = useState<UserRole>('user');
  const [cPassword, setCPassword] = useState('');
  const [cForceReset, setCForceReset] = useState(true);
  const [cActive, setCActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [copiedPw, setCopiedPw] = useState(false);

  // Edit modal
  const [editTarget, setEditTarget] = useState<UserRecord | null>(null);
  const [eUsername, setEUsername] = useState('');
  const [eDisplayName, setEDisplayName] = useState('');
  const [eEmail, setEEmail] = useState('');
  const [eRole, setERole] = useState<UserRole>('user');
  const [eActive, setEActive] = useState(true);
  const [eForceReset, setEForceReset] = useState(false);
  const [eNewPassword, setENewPassword] = useState('');
  const [eClearTotp, setEClearTotp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);
  const [reassignToId, setReassignToId] = useState<string>('');
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const users = useMemo(() => data?.users ?? [], [data?.users]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (statusFilter === 'active' && !u.isActive) return false;
      if (statusFilter === 'suspended' && u.isActive) return false;
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
      );
    });
  }, [users, search, roleFilter, statusFilter]);

  const stats = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      active: users.filter((u) => u.isActive).length,
      twoFa: users.filter((u) => u.totpEnabled).length,
    }),
    [users]
  );

  const openCreateModal = () => {
    setCUsername('');
    setCDisplayName('');
    setCEmail('');
    setCRole('user');
    setCPassword('');
    setCForceReset(true);
    setCActive(true);
    setCreateErr(null);
    setCopiedPw(false);
    setCreateOpen(true);
  };

  const openEditModal = (u: UserRecord) => {
    setEditTarget(u);
    setEUsername(u.username);
    setEDisplayName(u.displayName);
    setEEmail(u.email);
    setERole(u.role);
    setEActive(u.isActive);
    setEForceReset(u.mustChangePassword);
    setENewPassword('');
    setEClearTotp(false);
    setEditErr(null);
  };

  const handleCopyGenerated = async (val: string) => {
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      setCopiedPw(true);
      setTimeout(() => setCopiedPw(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken) return;
    setCreateErr(null);

    const normalizedUser = cUsername.trim().toLowerCase();
    if (!USERNAME_RE.test(normalizedUser)) {
      setCreateErr(
        'Username must be 3-32 characters starting with a lowercase letter.'
      );
      return;
    }
    if (cPassword.length < 12) {
      setCreateErr('Password must be at least 12 characters.');
      return;
    }

    setCreating(true);
    try {
      const res = await apiMutate<{ user: UserRecord }>(
        '/api/users',
        'POST',
        me.csrfToken,
        {
          username: normalizedUser,
          displayName: cDisplayName.trim(),
          email: cEmail.trim(),
          role: cRole,
          password: cPassword,
          mustChangePassword: cForceReset,
          isActive: cActive,
        }
      );
      setCreateOpen(false);
      setBanner({
        ok: true,
        text: `Created ${res.user.role} account "@${res.user.username}".`,
      });
      await mutate();
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!me?.csrfToken || !editTarget) return;
    setEditErr(null);

    if (eNewPassword && eNewPassword.length < 12) {
      setEditErr('Reset password must be at least 12 characters.');
      return;
    }

    setEditing(true);
    try {
      const res = await apiMutate<{ user: UserRecord }>(
        `/api/users/${editTarget.id}`,
        'PATCH',
        me.csrfToken,
        {
          username: editTarget.username === 'admin' ? undefined : eUsername.trim().toLowerCase(),
          displayName: eDisplayName.trim(),
          email: eEmail.trim(),
          role: eRole,
          isActive: eActive,
          mustChangePassword: eForceReset,
          password: eNewPassword || undefined,
          clearTotp: eClearTotp || undefined,
        }
      );
      setEditTarget(null);
      setBanner({
        ok: true,
        text: `Updated account "@${res.user.username}".`,
      });
      await mutate();
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setEditing(false);
    }
  };

  const handleDelete = async () => {
    if (!me?.csrfToken || !deleteTarget) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await apiMutate(
        `/api/users/${deleteTarget.id}`,
        'DELETE',
        me.csrfToken,
        reassignToId ? { reassignToUserId: Number.parseInt(reassignToId, 10) } : {}
      );
      const removedName = deleteTarget.username;
      setDeleteTarget(null);
      setReassignToId('');
      setBanner({
        ok: true,
        text: `Deleted user "@${removedName}".`,
      });
      await mutate();
    } catch (err) {
      setDeleteErr(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeleting(false);
    }
  };

  if (me && me.role !== 'admin') {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-6 text-sm text-rose-200">
        Administrator access is required to manage users.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Users Management
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Full CRUD account control. Standard users can provision their own sites &amp; databases while isolated from other accounts.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-accent-hover transition"
        >
          <IconPlus className="w-4 h-4" />
          <span>Create User</span>
        </button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total Users', value: stats.total, tone: 'text-slate-100' },
          { label: 'Administrators', value: stats.admins, tone: 'text-accent' },
          { label: 'Active Accounts', value: stats.active, tone: 'text-emerald-300' },
          { label: '2FA Protected', value: stats.twoFa, tone: 'text-sky-300' },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-borderline bg-surface px-4 py-3.5"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              {item.label}
            </div>
            <div className={`mt-1.5 text-2xl font-semibold ${item.tone}`}>
              {data ? item.value : '—'}
            </div>
          </div>
        ))}
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

      {/* Search & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borderline bg-surface p-3.5">
        <div className="relative flex-1 min-w-[220px]">
          <IconSearch className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            placeholder="Filter by username, name, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-borderline bg-canvas p-0.5 text-xs">
            {(['all', 'admin', 'user'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter(r)}
                className={`rounded-md px-2.5 py-1 capitalize transition ${
                  roleFilter === r
                    ? 'bg-elevated text-slate-100 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {r === 'all' ? 'All Roles' : `${r}s`}
              </button>
            ))}
          </div>

          <div className="flex rounded-lg border border-borderline bg-canvas p-0.5 text-xs">
            {(['all', 'active', 'suspended'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-md px-2.5 py-1 capitalize transition ${
                  statusFilter === st
                    ? 'bg-elevated text-slate-100 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Directory Table */}
      <div className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-borderline bg-canvas/50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">2FA</th>
                <th className="px-5 py-3 font-medium">Owned Resources</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderline">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">
                    {users.length === 0
                      ? 'Loading user directory...'
                      : 'No accounts match the active filters.'}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const initials = (u.displayName || u.username).slice(0, 2).toUpperCase();
                  const isSelf = me?.id === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-elevated/40">
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/users/${u.id}`}
                          className="flex items-center gap-3 group"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-borderline bg-canvas font-mono text-xs font-semibold text-slate-200 group-hover:border-accent/50 shrink-0">
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-medium text-slate-100 group-hover:text-accent transition">
                              <span className="truncate">
                                {u.displayName || `@${u.username}`}
                              </span>
                              {isSelf && (
                                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-mono text-accent">
                                  you
                                </span>
                              )}
                            </div>
                            <div className="truncate font-mono text-[11px] text-slate-500">
                              @{u.username}
                              {u.email ? ` · ${u.email}` : ''}
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge
                          tone={u.role === 'admin' ? 'blue' : 'slate'}
                          label={u.role === 'admin' ? 'Admin' : 'User'}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge
                            tone={u.isActive ? 'green' : 'red'}
                            label={u.isActive ? 'Active' : 'Suspended'}
                            dot
                          />
                          {u.mustChangePassword && (
                            <StatusBadge tone="amber" label="Pwd Reset" />
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge
                          tone={u.totpEnabled ? 'green' : 'slate'}
                          label={u.totpEnabled ? 'Protected' : 'Off'}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/users/${u.id}`}
                          className="inline-flex items-center gap-2 font-mono text-xs text-slate-300 hover:text-accent transition"
                        >
                          <span>{u.siteCount} site(s)</span>
                          <span className="text-slate-600">·</span>
                          <span>{u.dbCount} DB(s)</span>
                        </Link>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap font-mono text-xs text-slate-400">
                        {formatDateTime(u.updatedAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right whitespace-nowrap space-x-1.5">
                        <Link
                          href={`/users/${u.id}`}
                          className="inline-flex items-center rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
                        >
                          Manage
                        </Link>
                        <button
                          type="button"
                          onClick={() => openEditModal(u)}
                          className="inline-flex items-center rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
                        >
                          Edit
                        </button>
                        {!isSelf && u.username !== 'admin' && (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteErr(null);
                              setReassignToId('');
                              setDeleteTarget(u);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition"
                          >
                            <IconTrash className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create User Modal */}
      <Modal
        open={createOpen}
        title="Create Panel User"
        subtitle="Standard users can create & manage their own sites and SQLite databases without seeing other accounts' resources."
        onClose={() => !creating && setCreateOpen(false)}
        maxWidthClass="max-w-xl"
        badge={<IconUsers className="w-4 h-4 text-accent" />}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {createErr && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
              {createErr}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Username *
              </label>
              <input
                type="text"
                required
                autoFocus
                placeholder="e.g. john"
                value={cUsername}
                onChange={(e) => setCUsername(e.target.value.toLowerCase())}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Display Name
              </label>
              <input
                type="text"
                maxLength={64}
                placeholder="e.g. John Doe"
                value={cDisplayName}
                onChange={(e) => setCDisplayName(e.target.value)}
                className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Email Address (optional)
            </label>
            <input
              type="email"
              maxLength={120}
              placeholder="john@example.com"
              value={cEmail}
              onChange={(e) => setCEmail(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <div className="text-xs font-medium text-slate-300 mb-1.5">Role</div>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                {
                  role: 'user' as const,
                  title: 'Standard User',
                  desc: 'Add & manage own sites and databases only',
                },
                {
                  role: 'admin' as const,
                  title: 'Administrator',
                  desc: 'Full CRUD across all sites, DBs, users, services & logs',
                },
              ].map((opt) => (
                <button
                  key={opt.role}
                  type="button"
                  onClick={() => setCRole(opt.role)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    cRole === opt.role
                      ? 'border-accent/60 bg-accent/15 text-slate-100'
                      : 'border-borderline bg-canvas text-slate-400 hover:border-slate-500'
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-100">{opt.title}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-300">
                Initial Password (min 12 chars) *
              </label>
              <div className="flex items-center gap-2">
                {cPassword && (
                  <button
                    type="button"
                    onClick={() => handleCopyGenerated(cPassword)}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    {copiedPw ? (
                      <IconCheck className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <IconCopy className="w-3 h-3" />
                    )}
                    <span>{copiedPw ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCPassword(generateStrongPassword(16))}
                  className="text-[11px] font-medium text-accent hover:text-accent-hover"
                >
                  Generate Strong Password
                </button>
              </div>
            </div>
            <PasswordInput
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="Minimum 12 characters"
              value={cPassword}
              onChange={(e) => setCPassword(e.target.value)}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-borderline bg-canvas p-3">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cForceReset}
                onChange={(e) => setCForceReset(e.target.checked)}
                className="rounded border-borderline bg-surface text-accent"
              />
              <span>Require password change on first login</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cActive}
                onChange={(e) => setCActive(e.target.checked)}
                className="rounded border-borderline bg-surface text-accent"
              />
              <span>Account enabled immediately</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={Boolean(editTarget)}
        title={`Edit User · @${editTarget?.username || ''}`}
        subtitle="Update profile info, role permissions, account status, or reset credentials."
        onClose={() => !editing && setEditTarget(null)}
        maxWidthClass="max-w-xl"
      >
        {editTarget && (
          <form onSubmit={handleEdit} className="space-y-4">
            {editErr && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
                {editErr}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  required
                  disabled={editTarget.username === 'admin'}
                  value={eUsername}
                  onChange={(e) => setEUsername(e.target.value.toLowerCase())}
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
                  value={eDisplayName}
                  onChange={(e) => setEDisplayName(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  maxLength={120}
                  value={eEmail}
                  onChange={(e) => setEEmail(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Role
                </label>
                <select
                  value={eRole}
                  disabled={editTarget.username === 'admin' || me?.id === editTarget.id}
                  onChange={(e) => setERole(e.target.value as UserRole)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none disabled:opacity-60"
                >
                  <option value="user">User (Scoped Sites &amp; DBs)</option>
                  <option value="admin">Administrator (Full Access)</option>
                </select>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-300">
                  Reset Password (leave blank to keep current)
                </label>
                <button
                  type="button"
                  onClick={() => setENewPassword(generateStrongPassword(16))}
                  className="text-[11px] font-medium text-accent hover:text-accent-hover"
                >
                  Generate Password
                </button>
              </div>
              <PasswordInput
                minLength={12}
                autoComplete="new-password"
                placeholder="Optional new password (12+ chars)"
                value={eNewPassword}
                onChange={(e) => setENewPassword(e.target.value)}
              />
            </div>

            <div className="space-y-2 rounded-lg border border-borderline bg-canvas p-3">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={me?.id === editTarget.id}
                  checked={eActive}
                  onChange={(e) => setEActive(e.target.checked)}
                  className="rounded border-borderline bg-surface text-accent"
                />
                <span>Account enabled</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eForceReset}
                  onChange={(e) => setEForceReset(e.target.checked)}
                  className="rounded border-borderline bg-surface text-accent"
                />
                <span>Force password change on next login</span>
              </label>
              {editTarget.totpEnabled && (
                <label className="flex items-center gap-2 text-xs text-amber-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eClearTotp}
                    onChange={(e) => setEClearTotp(e.target.checked)}
                    className="rounded border-borderline bg-surface text-amber-400"
                  />
                  <span>Reset / disable user&apos;s TOTP 2FA</span>
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={editing}
                onClick={() => setEditTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editing}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
              >
                {editing ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Delete User Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        title="Delete User Account"
        subtitle="Revokes panel login sessions immediately."
        onClose={() => !deleting && setDeleteTarget(null)}
        badge={<IconShield className="w-4 h-4 text-rose-400" />}
      >
        {deleteTarget && (
          <div className="space-y-4">
            {deleteErr && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
                {deleteErr}
              </div>
            )}

            <p className="text-xs text-slate-300 leading-relaxed">
              Delete account <span className="font-mono font-semibold text-rose-300">@{deleteTarget.username}</span>?
              {(deleteTarget.siteCount > 0 || deleteTarget.dbCount > 0) && (
                <span className="block mt-2 text-amber-300">
                  This user currently owns {deleteTarget.siteCount} site(s) and {deleteTarget.dbCount} database(s). Files &amp; SQLite data remain on disk.
                </span>
              )}
            </p>

            {(deleteTarget.siteCount > 0 || deleteTarget.dbCount > 0) && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Transfer Owned Sites &amp; Databases To
                </label>
                <select
                  value={reassignToId}
                  onChange={(e) => setReassignToId(e.target.value)}
                  className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
                >
                  <option value="">Unassign (Administrators only)</option>
                  {users
                    .filter((other) => other.id !== deleteTarget.id && other.isActive)
                    .map((other) => (
                      <option key={other.id} value={String(other.id)}>
                        @{other.username} ({other.role})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDelete}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete User'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

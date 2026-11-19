'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { apiMutate } from '@/lib/client-api';
import {
  IconDashboard,
  IconDatabase,
  IconGlobe,
  IconLogOut,
  IconMenu,
  IconServer,
  IconSettings,
  IconShield,
  IconTerminal,
  IconUser,
  IconUsers,
  IconX,
} from './Icons';
import { PanelProvider, usePanel, type MeData } from './PanelContext';

const WORKSPACE_NAV = [
  { href: '/', label: 'Overview', Icon: IconDashboard },
  { href: '/sites', label: 'Sites', Icon: IconGlobe },
  { href: '/databases', label: 'Databases', Icon: IconDatabase },
];

const ADMIN_NAV = [
  { href: '/users', label: 'Users', Icon: IconUsers },
  { href: '/services', label: 'Services', Icon: IconServer },
  { href: '/logs', label: 'Logs', Icon: IconTerminal },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { me } = usePanel();
  const [loggingOut, setLoggingOut] = useState(false);

  const isAdmin = me?.role === 'admin';
  const mustChange = Boolean(me?.mustChangePassword);

  const handleLogout = async () => {
    if (!me?.csrfToken || loggingOut) return;
    setLoggingOut(true);
    try {
      await apiMutate('/api/auth/logout', 'POST', me.csrfToken);
    } finally {
      window.location.assign('/login');
    }
  };

  const renderNavItem = (
    href: string,
    label: string,
    Icon: React.ComponentType<{ className?: string }>
  ) => {
    const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
    const disabled = mustChange && href !== '/account' && href !== '/settings';

    return (
      <Link
        key={href}
        href={disabled ? '/account' : href}
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
          active
            ? 'bg-accent/15 text-accent border border-accent/30 shadow-sm'
            : disabled
              ? 'text-slate-600 cursor-not-allowed'
              : 'text-slate-300 hover:bg-elevated hover:text-slate-100 border border-transparent'
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span>{label}</span>
      </Link>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface border-r border-borderline">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-borderline">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 border border-accent/40 text-accent">
          <IconShield className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight text-slate-100">
            DietPi Panel
          </div>
          <div className="truncate text-[11px] font-mono text-slate-400">
            {me?.baseDomain ? `*.${me.baseDomain}` : 'connecting...'}
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        <div className="space-y-1">
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Workspace
          </div>
          {WORKSPACE_NAV.map((item) => renderNavItem(item.href, item.label, item.Icon))}
        </div>

        {isAdmin && (
          <div className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Administration
            </div>
            {ADMIN_NAV.map((item) => renderNavItem(item.href, item.label, item.Icon))}
          </div>
        )}

        <div className="space-y-1">
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Profile
          </div>
          {renderNavItem('/account', 'My Account', IconUser)}
        </div>
      </nav>

      <div className="border-t border-borderline p-4 space-y-3">
        {isAdmin && (
          <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2 border border-borderline">
            <span className="text-xs text-slate-400">Control Agent</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              <span
                className={`h-2 w-2 rounded-full ${
                  me?.agentConnected ? 'bg-emerald-400' : 'bg-rose-400'
                }`}
              />
              <span className={me?.agentConnected ? 'text-emerald-300' : 'text-rose-300'}>
                {me ? (me.agentConnected ? 'Online' : 'Offline') : '...'}
              </span>
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-1">
          <Link
            href="/account"
            onClick={onNavigate}
            className="min-w-0 flex-1 group"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-slate-200 group-hover:text-accent transition">
                {me?.displayName || me?.username || 'account'}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                  isAdmin
                    ? 'bg-accent/15 text-accent border border-accent/30'
                    : 'bg-slate-700/60 text-slate-300 border border-slate-600/40'
                }`}
              >
                {me?.role || 'user'}
              </span>
            </div>
            <div className="truncate text-[11px] font-mono text-slate-500">
              @{me?.username || '—'} · {me?.totpEnabled ? '2FA On' : '2FA Off'}
            </div>
          </Link>

          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut || !me?.csrfToken}
            title="Sign out"
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50 transition shrink-0"
          >
            <IconLogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { me } = usePanel();
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex bg-canvas">
      <aside className="hidden lg:block w-60 shrink-0 sticky top-0 h-screen">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative w-64 max-w-xs h-full z-50">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-3 rounded-lg p-1.5 text-slate-400 hover:text-white"
              aria-label="Close navigation"
            >
              <IconX />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex lg:hidden items-center justify-between border-b border-borderline bg-surface px-4 py-3">
          <div className="flex items-center gap-2.5">
            <IconShield className="w-5 h-5 text-accent" />
            <span className="text-sm font-semibold text-slate-100">DietPi Panel</span>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-elevated"
            aria-label="Open navigation"
          >
            <IconMenu />
          </button>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8 max-w-6xl w-full mx-auto">
          {me?.mustChangePassword &&
            pathname !== '/account' &&
            pathname !== '/settings' && (
              <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                <span>
                  Please update your temporary password before managing panel resources.
                </span>
                <Link
                  href="/account"
                  className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition"
                >
                  Update Password
                </Link>
              </div>
            )}
          {children}
        </main>
      </div>
    </div>
  );
}

export function PanelShell({
  initialMe,
  children,
}: {
  initialMe?: MeData;
  children: React.ReactNode;
}) {
  return (
    <PanelProvider initialMe={initialMe}>
      <ShellInner>{children}</ShellInner>
    </PanelProvider>
  );
}

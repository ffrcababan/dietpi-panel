'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { apiMutate } from '@/lib/client-api';
import {
  IconDashboard,
  IconDatabase,
  IconGlobe,
  IconLogOut,
  IconMenu,
  IconPanelLeftClose,
  IconPanelLeftOpen,
  IconServer,
  IconSettings,
  IconShield,
  IconTerminal,
  IconUser,
  IconUsers,
  IconX,
} from './Icons';
import { PanelProvider, usePanel, type MeData } from './PanelContext';

const SIDEBAR_STORAGE_KEY = 'dp_sidebar_collapsed';

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

function SidebarContent({
  collapsed = false,
  isMobileDrawer = false,
  onToggleCollapse,
  onNavigate,
}: {
  collapsed?: boolean;
  isMobileDrawer?: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { me } = usePanel();
  const [loggingOut, setLoggingOut] = useState(false);

  const isCollapsed = collapsed && !isMobileDrawer;
  const isAdmin = me?.role === 'admin';
  const mustChange = Boolean(me?.mustChangePassword);
  const avatarInitial = (me?.displayName || me?.username || 'A')
    .trim()
    .charAt(0)
    .toUpperCase();

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
    const disabled = mustChange && href !== '/account';

    return (
      <Link
        key={href}
        href={disabled ? '/account' : href}
        onClick={onNavigate}
        title={isCollapsed ? label : undefined}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={`relative group flex items-center rounded-xl text-sm font-medium transition-all duration-150 ${
          isCollapsed ? 'justify-center h-10 w-10 mx-auto px-0' : 'gap-3 px-3 py-2'
        } ${
          active
            ? 'bg-gradient-to-r from-accent/20 to-accent/5 text-accent border border-accent/35 shadow-[0_0_16px_-6px_rgba(243,128,32,0.5)]'
            : disabled
              ? 'text-slate-600 cursor-not-allowed border border-transparent'
              : 'text-slate-300 hover:bg-elevated/80 hover:text-slate-100 border border-transparent'
        }`}
      >
        <Icon
          className={`${isCollapsed ? 'w-[18px] h-[18px]' : 'w-4 h-4'} shrink-0 transition-transform duration-150 ${
            !active && !disabled ? 'group-hover:scale-105' : ''
          }`}
        />
        {!isCollapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface/95 backdrop-blur-md border-r border-borderline">
      {/* Header / Brand + Collapse Toggle */}
      <div
        className={`border-b border-borderline ${
          isCollapsed
            ? 'flex flex-col items-center gap-2.5 py-4 px-2'
            : 'flex items-center justify-between gap-2.5 px-4 py-4'
        }`}
      >
        <div className={`flex items-center gap-3 min-w-0 ${isCollapsed ? 'justify-center' : ''}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent/5 border border-accent/40 text-accent shadow-inner">
            <IconShield className="w-[18px] h-[18px]" />
          </div>
          {!isCollapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-slate-100 truncate">
                DietPi Panel
              </div>
              <div className="truncate text-[11px] font-mono text-slate-400">
                {me?.baseDomain ? `*.${me.baseDomain}` : 'connecting...'}
              </div>
            </div>
          )}
        </div>

        {!isMobileDrawer && onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!isCollapsed}
            className={`flex items-center justify-center rounded-lg border border-borderline/80 bg-canvas/70 text-slate-400 hover:border-slate-500 hover:text-slate-100 hover:bg-elevated transition ${
              isCollapsed ? 'h-8 w-10' : 'h-8 w-8 shrink-0'
            }`}
          >
            {isCollapsed ? (
              <IconPanelLeftOpen className="w-4 h-4 text-accent" />
            ) : (
              <IconPanelLeftClose className="w-4 h-4" />
            )}
          </button>
        )}
      </div>

      {/* Primary Navigation */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-4 space-y-4">
        <div className="space-y-1">
          {!isCollapsed ? (
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Workspace
            </div>
          ) : (
            <div className="sr-only">Workspace</div>
          )}
          {WORKSPACE_NAV.map((item) => renderNavItem(item.href, item.label, item.Icon))}
        </div>

        {isAdmin && (
          <div className="space-y-1">
            {!isCollapsed ? (
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Administration
              </div>
            ) : (
              <div className="h-px bg-borderline/70 mx-2 my-2" aria-hidden="true" />
            )}
            {ADMIN_NAV.map((item) => renderNavItem(item.href, item.label, item.Icon))}
          </div>
        )}

        <div className="space-y-1">
          {!isCollapsed ? (
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Profile
            </div>
          ) : (
            <div className="h-px bg-borderline/70 mx-2 my-2" aria-hidden="true" />
          )}
          {renderNavItem('/account', 'My Account', IconUser)}
        </div>
      </nav>

      {/* Footer / Control Agent Status & User Account */}
      <div className={`border-t border-borderline ${isCollapsed ? 'p-2.5 space-y-2.5' : 'p-3.5 space-y-3'}`}>
        {isAdmin &&
          (isCollapsed ? (
            <div
              title={`Control Agent: ${me ? (me.agentConnected ? 'Online' : 'Offline') : 'Checking'}`}
              className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-canvas border border-borderline"
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  me?.agentConnected
                    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]'
                    : 'bg-rose-400'
                }`}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2 border border-borderline">
              <span className="text-xs text-slate-400">Control Agent</span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <span
                  className={`h-2 w-2 rounded-full ${
                    me?.agentConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                  }`}
                />
                <span className={me?.agentConnected ? 'text-emerald-300' : 'text-rose-300'}>
                  {me ? (me.agentConnected ? 'Online' : 'Offline') : '...'}
                </span>
              </span>
            </div>
          ))}

        {isCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            <Link
              href="/account"
              onClick={onNavigate}
              title={`${me?.displayName || me?.username || 'Account'} (@${me?.username || '—'})`}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-borderline bg-elevated text-xs font-semibold text-slate-100 hover:border-accent/60 hover:text-accent transition"
            >
              {avatarInitial}
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut || !me?.csrfToken}
              title="Sign out"
              aria-label="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-borderline bg-elevated text-slate-300 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-50 transition"
            >
              <IconLogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-0.5">
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
              aria-label="Sign out"
              className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50 transition shrink-0"
            >
              <IconLogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { me } = usePanel();
  const pathname = usePathname();

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (saved === '1') {
        setCollapsed(true);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  // Support Ctrl+B / Cmd+B sidebar collapse shortcut on desktop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
        e.preventDefault();
        toggleCollapsed();
      } else if (e.key === 'Escape' && mobileOpen) {
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  // Prevent background scroll when mobile drawer is open
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <div className="min-h-screen flex bg-canvas">
      <aside
        className={`hidden lg:block shrink-0 sticky top-0 h-screen transition-[width] duration-200 ease-out ${
          collapsed ? 'w-[72px]' : 'w-64'
        }`}
      >
        <SidebarContent
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
        />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative w-64 max-w-xs h-full z-50">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-3 z-10 rounded-lg p-1.5 text-slate-400 hover:bg-elevated hover:text-white transition"
              aria-label="Close navigation"
            >
              <IconX />
            </button>
            <SidebarContent
              collapsed={false}
              isMobileDrawer={true}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex lg:hidden items-center justify-between border-b border-borderline bg-surface px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 border border-accent/35 text-accent">
              <IconShield className="w-4 h-4" />
            </div>
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

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8 max-w-7xl w-full mx-auto min-w-0">
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

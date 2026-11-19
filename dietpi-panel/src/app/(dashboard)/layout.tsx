import { redirect } from 'next/navigation';
import { PanelShell } from '@/components/PanelShell';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await requireAdmin(undefined, { allowPendingPasswordChange: true });
  if (!auth.ok) {
    redirect('/login');
  }

  return (
    <PanelShell
      initialMe={{
        username: auth.user.username,
        csrfToken: auth.payload.csrf,
        mustChangePassword: auth.user.must_change_password === 1,
        totpEnabled: Boolean(auth.user.totp_secret),
        baseDomain: process.env.BASE_DOMAIN || 'localhost',
        agentConnected: false,
      }}
    >
      {children}
    </PanelShell>
  );
}

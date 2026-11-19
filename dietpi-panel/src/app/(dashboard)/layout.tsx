import { redirect } from 'next/navigation';
import { PanelShell } from '@/components/PanelShell';
import { requireSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await requireSession(undefined, { allowPendingPasswordChange: true });
  if (!auth.ok) {
    redirect('/login');
  }

  return (
    <PanelShell
      initialMe={{
        id: auth.user.id,
        username: auth.user.username,
        displayName: auth.user.display_name,
        email: auth.user.email,
        role: auth.user.role,
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

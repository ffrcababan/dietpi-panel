import { NextResponse } from 'next/server';
import { callControlAgent } from '@/lib/agent';
import { requireSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSession(undefined, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  let agentConnected = false;
  try {
    const pingRes = await callControlAgent('ping', {}, 800);
    agentConnected = pingRes.ok;
  } catch {
    agentConnected = false;
  }

  return NextResponse.json(
    {
      id: auth.user.id,
      username: auth.user.username,
      displayName: auth.user.display_name,
      email: auth.user.email,
      role: auth.user.role,
      csrfToken: auth.payload.csrf,
      mustChangePassword: auth.user.must_change_password === 1,
      totpEnabled: Boolean(auth.user.totp_secret),
      baseDomain: process.env.BASE_DOMAIN || 'localhost',
      agentConnected,
      apacheUnit: process.env.APACHE_SERVICE || 'apache2',
      webUser: process.env.WEB_USER || 'www-data',
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    }
  );
}

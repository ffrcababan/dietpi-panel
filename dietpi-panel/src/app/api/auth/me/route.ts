import { NextResponse } from 'next/server';
import { callControlAgent } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin(undefined, { allowPendingPasswordChange: true });
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
      username: auth.user.username,
      csrfToken: auth.payload.csrf,
      mustChangePassword: auth.user.must_change_password === 1,
      totpEnabled: Boolean(auth.user.totp_secret),
      baseDomain: process.env.BASE_DOMAIN || 'localhost',
      agentConnected,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    }
  );
}

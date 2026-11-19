import { NextResponse } from 'next/server';
import { clearSessionCookie, requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireAdmin(request, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}

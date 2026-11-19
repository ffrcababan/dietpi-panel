import { NextResponse } from 'next/server';
import { clearSessionCookie, requireSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireSession(request, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  const res = NextResponse.json(
    { ok: true },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    }
  );
  clearSessionCookie(res);
  return res;
}

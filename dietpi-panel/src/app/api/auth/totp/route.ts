import { NextResponse } from 'next/server';
import { getPendingTotpSession, issueSessionCookie } from '@/lib/auth';
import { verifyTotpCode } from '@/lib/crypto';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitFailure,
  resetRateLimit,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rlKey = `totp:${ip}`;
  const limit = checkRateLimit(rlKey);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many 2FA attempts. Try again in ${limit.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      }
    );
  }

  const pending = await getPendingTotpSession();
  if (!pending || !pending.user.totp_secret) {
    return NextResponse.json(
      { error: '2FA session expired. Please sign in again.' },
      { status: 401 }
    );
  }

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!verifyTotpCode(pending.user.totp_secret, code)) {
    recordRateLimitFailure(rlKey);
    return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 401 });
  }

  resetRateLimit(rlKey);
  resetRateLimit(`login:${ip}`);

  const res = NextResponse.json(
    {
      ok: true,
      mustChangePassword: pending.user.must_change_password === 1,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
      },
    }
  );
  await issueSessionCookie(res, pending.user, 'full');
  return res;
}

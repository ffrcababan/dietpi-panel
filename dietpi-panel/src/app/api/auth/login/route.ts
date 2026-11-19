import { NextResponse } from 'next/server';
import { issueSessionCookie } from '@/lib/auth';
import { verifyPassword } from '@/lib/crypto';
import { getUserByUsername } from '@/lib/db';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitFailure,
  resetRateLimit,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rlKey = `login:${ip}`;
  const limit = checkRateLimit(rlKey);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Too many login attempts. Try again in ${limit.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      }
    );
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password || username.length > 64 || password.length > 256) {
    recordRateLimitFailure(rlKey);
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const user = await getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordRateLimitFailure(rlKey);
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  if (user.is_active !== 1) {
    return NextResponse.json(
      { error: 'This account is suspended. Contact an administrator.' },
      { status: 403 }
    );
  }

  if (user.totp_secret) {
    const res = NextResponse.json(
      { ok: true, requiresTotp: true },
      { headers: { 'Cache-Control': 'no-store, private' } }
    );
    await issueSessionCookie(res, user, 'totp_pending');
    return res;
  }

  resetRateLimit(rlKey);
  const res = NextResponse.json(
    {
      ok: true,
      requiresTotp: false,
      mustChangePassword: user.must_change_password === 1,
    },
    { headers: { 'Cache-Control': 'no-store, private' } }
  );
  await issueSessionCookie(res, user, 'full');
  return res;
}

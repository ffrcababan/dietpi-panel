import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { constantTimeEqual } from './crypto';
import { getUserById, type UserRow } from './db';
import {
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from './session-token';

const FULL_SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours
const PENDING_TOTP_TTL_SEC = 5 * 60; // 5 minutes
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret || secret.length < 16) {
    throw new Error('Server misconfiguration: SESSION_SECRET is not set');
  }
  return secret;
}

export function getCookieSecurityFlag(): boolean {
  return process.env.ALLOW_INSECURE_LOCAL_COOKIE !== 'true';
}

export async function issueSessionCookie(
  response: NextResponse,
  user: UserRow,
  stage: 'full' | 'totp_pending',
  csrfOverride?: string
): Promise<SessionPayload> {
  const secret = getSessionSecret();
  const ttl = stage === 'full' ? FULL_SESSION_TTL_SEC : PENDING_TOTP_TTL_SEC;
  const payload: SessionPayload = {
    sub: user.id,
    username: user.username,
    ver: user.session_version,
    csrf: csrfOverride || crypto.randomBytes(24).toString('hex'),
    stage,
    mustChangePassword: user.must_change_password === 1,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };

  const token = await signSessionToken(payload, secret);
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: getCookieSecurityFlag(),
    path: '/',
    maxAge: ttl,
  });

  return payload;
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: getCookieSecurityFlag(),
    path: '/',
    maxAge: 0,
  });
}

export async function getPendingTotpSession(): Promise<{
  user: UserRow;
  payload: SessionPayload;
} | null> {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifySessionToken(token, getSessionSecret());
  if (!payload || payload.stage !== 'totp_pending') {
    return null;
  }
  const user = await getUserById(payload.sub);
  if (!user || user.session_version !== payload.ver) {
    return null;
  }
  return { user, payload };
}

export type AdminAuthResult =
  | {
      ok: true;
      user: UserRow;
      payload: SessionPayload;
    }
  | {
      ok: false;
      response: NextResponse;
    };

export async function requireAdmin(
  request?: Request,
  options: { allowPendingPasswordChange?: boolean } = {}
): Promise<AdminAuthResult> {
  let secret: string;
  try {
    secret = getSessionSecret();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Server authentication is not configured' },
        { status: 500 }
      ),
    };
  }

  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token, secret);
  if (!payload || payload.stage !== 'full') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const user = await getUserById(payload.sub);
  if (!user || user.session_version !== payload.ver) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Session invalidated' }, { status: 401 }),
    };
  }

  if (request && MUTATING_METHODS.has(request.method.toUpperCase())) {
    const csrfHeader = request.headers.get('x-panel-csrf') || '';
    if (!csrfHeader || !constantTimeEqual(csrfHeader, payload.csrf)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Invalid or missing x-panel-csrf token' },
          { status: 403 }
        ),
      };
    }
  }

  if (user.must_change_password === 1 && !options.allowPendingPasswordChange) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Password change required on first login',
          code: 'PASSWORD_CHANGE_REQUIRED',
        },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user, payload };
}

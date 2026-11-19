import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { issueSessionCookie, requireSession } from '@/lib/auth';
import { verifyPassword } from '@/lib/crypto';
import {
  getUserByUsername,
  getUserOwnedResources,
  updateUserProfile,
} from '@/lib/db';
import {
  validateDisplayName,
  validateEmail,
  validateUsername,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export async function GET() {
  const auth = await requireSession(undefined, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  try {
    const owned = await getUserOwnedResources(auth.user.id);
    return NextResponse.json(
      {
        account: {
          id: auth.user.id,
          username: auth.user.username,
          displayName: auth.user.display_name,
          email: auth.user.email,
          role: auth.user.role,
          totpEnabled: Boolean(auth.user.totp_secret),
          mustChangePassword: auth.user.must_change_password === 1,
          createdAt: auth.user.created_at,
          updatedAt: auth.user.updated_at,
          siteCount: owned.sites.length,
          dbCount: owned.databases.length,
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load account' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await requireSession(request, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  let body: {
    username?: unknown;
    displayName?: unknown;
    email?: unknown;
    currentPassword?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const displayCheck = validateDisplayName(body.displayName);
  if (!displayCheck.ok) {
    return NextResponse.json({ error: displayCheck.error }, { status: 400 });
  }

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) {
    return NextResponse.json({ error: emailCheck.error }, { status: 400 });
  }

  let nextUsername: string | undefined;
  if (body.username !== undefined) {
    const userCheck = validateUsername(body.username);
    if (!userCheck.ok) {
      return NextResponse.json({ error: userCheck.error }, { status: 400 });
    }
    if (userCheck.value !== auth.user.username) {
      if (auth.user.username === 'admin') {
        return NextResponse.json(
          { error: 'The primary "admin" username cannot be renamed' },
          { status: 400 }
        );
      }
      const pw = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (!verifyPassword(pw, auth.user.password_hash)) {
        return NextResponse.json(
          { error: 'Current password is required to change your username' },
          { status: 400 }
        );
      }
      const conflict = await getUserByUsername(userCheck.value);
      if (conflict && conflict.id !== auth.user.id) {
        return NextResponse.json(
          { error: `Username "${userCheck.value}" is already taken` },
          { status: 409 }
        );
      }
      nextUsername = userCheck.value;
    }
  }

  try {
    const { user: updated, usernameChanged } = await updateUserProfile(auth.user.id, {
      username: nextUsername,
      displayName: displayCheck.value,
      email: emailCheck.value,
    });
    if (!updated) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    let csrfToken = auth.payload.csrf;
    const responsePayload: {
      ok: true;
      csrfToken?: string;
      account: {
        id: number;
        username: string;
        displayName: string;
        email: string;
        role: 'admin' | 'user';
        updatedAt: string;
      };
    } = {
      ok: true,
      account: {
        id: updated.id,
        username: updated.username,
        displayName: updated.display_name,
        email: updated.email,
        role: updated.role,
        updatedAt: updated.updated_at,
      },
    };

    if (usernameChanged) {
      csrfToken = crypto.randomBytes(24).toString('hex');
      responsePayload.csrfToken = csrfToken;
    }

    const res = NextResponse.json(responsePayload, { headers: NO_STORE_HEADERS });
    if (usernameChanged) {
      await issueSessionCookie(res, updated, 'full', csrfToken);
    }
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update account' },
      { status: 500 }
    );
  }
}

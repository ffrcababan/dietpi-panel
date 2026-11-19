import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { issueSessionCookie, requireAdmin } from '@/lib/auth';
import { hashPassword, verifyPassword } from '@/lib/crypto';
import { updateUserPassword } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireAdmin(request, { allowPendingPasswordChange: true });
  if (!auth.ok) return auth.response;

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await request.json()) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const currentPassword =
    typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword =
    typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!verifyPassword(currentPassword, auth.user.password_hash)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
  }

  if (newPassword.length < 12 || newPassword.length > 128) {
    return NextResponse.json(
      { error: 'New password must be between 12 and 128 characters' },
      { status: 400 }
    );
  }

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: 'New password must differ from current password' },
      { status: 400 }
    );
  }

  const updatedUser = await updateUserPassword(auth.user.id, hashPassword(newPassword));
  if (!updatedUser) {
    return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
  }

  const csrfToken = crypto.randomBytes(24).toString('hex');
  const res = NextResponse.json(
    { ok: true, csrfToken },
    {
      headers: {
        'Cache-Control': 'no-store, private',
      },
    }
  );
  await issueSessionCookie(res, updatedUser, 'full', csrfToken);
  return res;
}

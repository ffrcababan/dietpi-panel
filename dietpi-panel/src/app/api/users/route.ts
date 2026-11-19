import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { hashPassword } from '@/lib/crypto';
import {
  createUser,
  getUserByUsername,
  listUsersWithResourceCounts,
  type PublicUserSummary,
} from '@/lib/db';
import {
  validateDisplayName,
  validateEmail,
  validateUserRole,
  validateUsername,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

export type UserRecord = PublicUserSummary;

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const users = await listUsersWithResourceCounts();
    return NextResponse.json({ users }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list users' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let body: {
    username?: unknown;
    displayName?: unknown;
    email?: unknown;
    role?: unknown;
    password?: unknown;
    mustChangePassword?: unknown;
    isActive?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const userCheck = validateUsername(body.username);
  if (!userCheck.ok) {
    return NextResponse.json({ error: userCheck.error }, { status: 400 });
  }

  const displayCheck = validateDisplayName(body.displayName);
  if (!displayCheck.ok) {
    return NextResponse.json({ error: displayCheck.error }, { status: 400 });
  }

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) {
    return NextResponse.json({ error: emailCheck.error }, { status: 400 });
  }

  const roleCheck = validateUserRole(body.role ?? 'user');
  if (!roleCheck.ok) {
    return NextResponse.json({ error: roleCheck.error }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 12 || password.length > 128) {
    return NextResponse.json(
      { error: 'Password must be between 12 and 128 characters' },
      { status: 400 }
    );
  }

  try {
    const existing = await getUserByUsername(userCheck.value);
    if (existing) {
      return NextResponse.json(
        { error: `Username "${userCheck.value}" already exists` },
        { status: 409 }
      );
    }

    const created = await createUser({
      username: userCheck.value,
      displayName: displayCheck.value,
      email: emailCheck.value,
      role: roleCheck.value,
      passwordHash: hashPassword(password),
      mustChangePassword: body.mustChangePassword !== false,
      isActive: body.isActive !== false,
    });

    const summary: UserRecord = {
      id: created.id,
      username: created.username,
      displayName: created.display_name,
      email: created.email,
      role: created.role,
      isActive: created.is_active === 1,
      mustChangePassword: created.must_change_password === 1,
      totpEnabled: Boolean(created.totp_secret),
      siteCount: 0,
      dbCount: 0,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
    };

    return NextResponse.json(
      { user: summary },
      { status: 201, headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create user' },
      { status: 500 }
    );
  }
}

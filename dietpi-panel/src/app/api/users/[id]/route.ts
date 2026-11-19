import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';
import { hashPassword } from '@/lib/crypto';
import {
  countActiveAdmins,
  deleteResourceOwner,
  deleteUserById,
  getAllResourceOwnerMap,
  getUserById,
  getUserByUsername,
  getUserOwnedResources,
  listUsersWithResourceCounts,
  setResourceOwner,
  updateUserByAdmin,
  type ResourceType,
} from '@/lib/db';
import {
  validateDisplayName,
  validateEmail,
  validateResourceName,
  validateUserRole,
  validateUsername,
  type UserRole,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

function parseUserId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const userId = parseUserId(context.params.id);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  try {
    const user = await getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const owned = await getUserOwnedResources(user.id);
    const allUsers = await listUsersWithResourceCounts();

    let allSites: Array<{
      name: string;
      serverName: string;
      type: string;
      ownerUsername: string | null;
    }> = [];
    let allDatabases: Array<{
      name: string;
      domain: string;
      ownerUsername: string | null;
    }> = [];

    try {
      const [sitesResp, dbResp, siteOwnerMap, dbOwnerMap] = await Promise.all([
        callControlAgent('site.list'),
        callControlAgent('db.list'),
        getAllResourceOwnerMap('site'),
        getAllResourceOwnerMap('database'),
      ]);

      if (sitesResp.ok) {
        const parsedSites = parseAgentJson<
          Array<{
            name: string;
            serverName: string;
            type: string;
            isPanel: boolean;
          }>
        >(sitesResp, 'Failed to read sites');
        allSites = parsedSites
          .filter((s) => !s.isPanel && s.type !== 'dbonly')
          .map((s) => ({
            name: s.name,
            serverName: s.serverName,
            type: s.type,
            ownerUsername: siteOwnerMap.get(s.name)?.ownerUsername ?? null,
          }));
      }

      if (dbResp.ok) {
        const parsedDbs = parseAgentJson<
          Array<{ name: string; domain: string }>
        >(dbResp, 'Failed to read databases');
        allDatabases = parsedDbs.map((d) => ({
          name: d.name,
          domain: d.domain,
          ownerUsername: dbOwnerMap.get(d.name)?.ownerUsername ?? null,
        }));
      }
    } catch {
      // Agent offline fallback: return DB ownership rows gracefully
    }

    return NextResponse.json(
      {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          email: user.email,
          role: user.role,
          isActive: user.is_active === 1,
          mustChangePassword: user.must_change_password === 1,
          totpEnabled: Boolean(user.totp_secret),
          siteCount: owned.sites.length,
          dbCount: owned.databases.length,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        owned,
        availableSites: allSites,
        availableDatabases: allDatabases,
        transferTargets: allUsers
          .filter((u) => u.id !== user.id && u.isActive)
          .map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            role: u.role,
          })),
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load user' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: { id: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const userId = parseUserId(context.params.id);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  let body: {
    username?: unknown;
    displayName?: unknown;
    email?: unknown;
    role?: unknown;
    isActive?: unknown;
    password?: unknown;
    mustChangePassword?: unknown;
    clearTotp?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const target = await getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    let nextUsername: string | undefined;
    if (body.username !== undefined) {
      const userCheck = validateUsername(body.username);
      if (!userCheck.ok) {
        return NextResponse.json({ error: userCheck.error }, { status: 400 });
      }
      if (userCheck.value !== target.username) {
        if (target.username === 'admin') {
          return NextResponse.json(
            { error: 'The primary "admin" username cannot be renamed' },
            { status: 400 }
          );
        }
        const conflict = await getUserByUsername(userCheck.value);
        if (conflict && conflict.id !== target.id) {
          return NextResponse.json(
            { error: `Username "${userCheck.value}" already exists` },
            { status: 409 }
          );
        }
        nextUsername = userCheck.value;
      }
    }

    let nextDisplayName: string | undefined;
    if (body.displayName !== undefined) {
      const displayCheck = validateDisplayName(body.displayName);
      if (!displayCheck.ok) {
        return NextResponse.json({ error: displayCheck.error }, { status: 400 });
      }
      nextDisplayName = displayCheck.value;
    }

    let nextEmail: string | undefined;
    if (body.email !== undefined) {
      const emailCheck = validateEmail(body.email);
      if (!emailCheck.ok) {
        return NextResponse.json({ error: emailCheck.error }, { status: 400 });
      }
      nextEmail = emailCheck.value;
    }

    let nextRole: UserRole | undefined;
    if (body.role !== undefined) {
      const roleCheck = validateUserRole(body.role);
      if (!roleCheck.ok) {
        return NextResponse.json({ error: roleCheck.error }, { status: 400 });
      }
      if (roleCheck.value !== target.role) {
        if (target.id === auth.user.id && roleCheck.value !== 'admin') {
          return NextResponse.json(
            { error: 'You cannot demote your own administrator account' },
            { status: 400 }
          );
        }
        if (target.username === 'admin' && roleCheck.value !== 'admin') {
          return NextResponse.json(
            { error: 'The primary "admin" account must remain an administrator' },
            { status: 400 }
          );
        }
        if (target.role === 'admin' && target.is_active === 1 && roleCheck.value !== 'admin') {
          const remaining = await countActiveAdmins(target.id);
          if (remaining < 1) {
            return NextResponse.json(
              { error: 'At least one active administrator is required' },
              { status: 400 }
            );
          }
        }
      }
      nextRole = roleCheck.value;
    }

    let nextIsActive: boolean | undefined;
    if (body.isActive !== undefined) {
      const desiredActive = Boolean(body.isActive);
      if (!desiredActive) {
        if (target.id === auth.user.id) {
          return NextResponse.json(
            { error: 'You cannot suspend your own active account' },
            { status: 400 }
          );
        }
        if (target.role === 'admin' && target.is_active === 1) {
          const remaining = await countActiveAdmins(target.id);
          if (remaining < 1) {
            return NextResponse.json(
              { error: 'Cannot suspend the last active administrator account' },
              { status: 400 }
            );
          }
        }
      }
      nextIsActive = desiredActive;
    }

    let nextPasswordHash: string | undefined;
    if (typeof body.password === 'string' && body.password !== '') {
      if (body.password.length < 12 || body.password.length > 128) {
        return NextResponse.json(
          { error: 'New password must be between 12 and 128 characters' },
          { status: 400 }
        );
      }
      nextPasswordHash = hashPassword(body.password);
    }

    const updated = await updateUserByAdmin(target.id, {
      username: nextUsername,
      displayName: nextDisplayName,
      email: nextEmail,
      role: nextRole,
      isActive: nextIsActive,
      passwordHash: nextPasswordHash,
      mustChangePassword:
        body.mustChangePassword !== undefined
          ? Boolean(body.mustChangePassword)
          : undefined,
      clearTotp: body.clearTotp === true,
    });

    if (!updated) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const owned = await getUserOwnedResources(updated.id);
    return NextResponse.json(
      {
        user: {
          id: updated.id,
          username: updated.username,
          displayName: updated.display_name,
          email: updated.email,
          role: updated.role,
          isActive: updated.is_active === 1,
          mustChangePassword: updated.must_change_password === 1,
          totpEnabled: Boolean(updated.totp_secret),
          siteCount: owned.sites.length,
          dbCount: owned.databases.length,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update user' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const userId = parseUserId(context.params.id);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  let body: {
    action?: unknown;
    resourceType?: unknown;
    resourceName?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action !== 'assign' && body.action !== 'unassign') {
    return NextResponse.json(
      { error: 'Action must be assign or unassign' },
      { status: 400 }
    );
  }

  if (body.resourceType !== 'site' && body.resourceType !== 'database') {
    return NextResponse.json(
      { error: 'resourceType must be site or database' },
      { status: 400 }
    );
  }

  const nameCheck = validateResourceName(body.resourceName, body.resourceType);
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }

  try {
    const user = await getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const rType: ResourceType = body.resourceType;
    if (body.action === 'assign') {
      await setResourceOwner(rType, nameCheck.value, user.id);
    } else {
      await deleteResourceOwner(rType, nameCheck.value);
    }

    const owned = await getUserOwnedResources(user.id);
    return NextResponse.json(
      { ok: true, owned },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update ownership' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: { id: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const userId = parseUserId(context.params.id);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  let reassignToUserId: number | undefined;
  try {
    const raw = await request.text();
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as { reassignToUserId?: unknown };
      if (parsed.reassignToUserId !== undefined && parsed.reassignToUserId !== null) {
        const parsedId = Number(parsed.reassignToUserId);
        if (!Number.isSafeInteger(parsedId) || parsedId <= 0 || parsedId === userId) {
          return NextResponse.json(
            { error: 'Invalid transfer target user ID' },
            { status: 400 }
          );
        }
        const transferTarget = await getUserById(parsedId);
        if (!transferTarget) {
          return NextResponse.json(
            { error: 'Transfer target user does not exist' },
            { status: 404 }
          );
        }
        reassignToUserId = transferTarget.id;
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const target = await getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (target.id === auth.user.id) {
      return NextResponse.json(
        { error: 'You cannot delete your own account' },
        { status: 400 }
      );
    }
    if (target.username === 'admin') {
      return NextResponse.json(
        { error: 'The primary "admin" account cannot be deleted' },
        { status: 400 }
      );
    }
    if (target.role === 'admin' && target.is_active === 1) {
      const remaining = await countActiveAdmins(target.id);
      if (remaining < 1) {
        return NextResponse.json(
          { error: 'Cannot delete the last active administrator account' },
          { status: 400 }
        );
      }
    }

    await deleteUserById(target.id, reassignToUserId);
    return NextResponse.json(
      { ok: true, deletedUsername: target.username },
      { headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete user' },
      { status: 500 }
    );
  }
}

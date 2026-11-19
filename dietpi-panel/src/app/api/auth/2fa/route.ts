import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { getSessionSecret, requireSession } from '@/lib/auth';
import {
  buildOtpAuthUri,
  constantTimeEqual,
  generateTotpSecret,
  verifyPassword,
  verifyTotpCode,
} from '@/lib/crypto';
import { setUserTotpSecret } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface SetupTokenPayload {
  uid: number;
  secret: string;
  exp: number;
}

function signSetupToken(userId: number, totpSecret: string): string {
  const payload: SetupTokenPayload = {
    uid: userId,
    secret: totpSecret,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`totp-setup:${b64}`)
    .digest('base64url');
  return `${b64}.${sig}`;
}

function verifySetupToken(token: string, userId: number): string | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const b64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`totp-setup:${b64}`)
    .digest('base64url');
  if (!constantTimeEqual(sig, expectedSig)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(b64, 'base64url').toString('utf8')
    ) as SetupTokenPayload;
    if (
      parsed.uid !== userId ||
      typeof parsed.secret !== 'string' ||
      parsed.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return parsed.secret;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  let body: { action?: unknown; setupToken?: unknown; code?: unknown };
  try {
    body = (await request.json()) as {
      action?: unknown;
      setupToken?: unknown;
      code?: unknown;
    };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'setup') {
    const secret = generateTotpSecret();
    const otpauthUri = buildOtpAuthUri(auth.user.username, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
      margin: 2,
      width: 200,
      color: {
        dark: '#0b0e14',
        light: '#f8fafc',
      },
    });
    const setupToken = signSetupToken(auth.user.id, secret);
    return NextResponse.json({
      secret,
      otpauthUri,
      qrDataUrl,
      setupToken,
    });
  }

  if (body.action === 'enable') {
    const setupToken = typeof body.setupToken === 'string' ? body.setupToken : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const secret = verifySetupToken(setupToken, auth.user.id);
    if (!secret) {
      return NextResponse.json(
        { error: '2FA setup session expired; please generate a new QR code' },
        { status: 400 }
      );
    }
    if (!verifyTotpCode(secret, code)) {
      return NextResponse.json(
        { error: 'Invalid 6-digit verification code' },
        { status: 400 }
      );
    }
    await setUserTotpSecret(auth.user.id, secret);
    return NextResponse.json({ ok: true, totpEnabled: true });
  }

  return NextResponse.json({ error: 'Unsupported 2FA action' }, { status: 400 });
}

export async function DELETE(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  let body: { currentPassword?: unknown; code?: unknown };
  try {
    body = (await request.json()) as { currentPassword?: unknown; code?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const currentPassword =
    typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!verifyPassword(currentPassword, auth.user.password_hash)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
  }

  if (auth.user.totp_secret) {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!verifyTotpCode(auth.user.totp_secret, code)) {
      return NextResponse.json(
        { error: 'Valid 6-digit TOTP code required to disable 2FA' },
        { status: 400 }
      );
    }
  }

  await setUserTotpSecret(auth.user.id, null);
  return NextResponse.json({ ok: true, totpEnabled: false });
}

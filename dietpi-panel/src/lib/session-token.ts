export const SESSION_COOKIE_NAME = 'dp_session';

export interface SessionPayload {
  sub: number;
  username: string;
  role?: 'admin' | 'user';
  ver: number;
  csrf: string;
  stage: 'full' | 'totp_pending';
  mustChangePassword: boolean;
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str: string): Uint8Array | null {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const binary = atob(base64 + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSessionToken(
  payload: SessionPayload,
  secret: string
): Promise<string> {
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET must be at least 16 characters');
  }
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const payloadB64 = toBase64Url(payloadBytes);
  const key = await importHmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sigBuf));
  return `${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<SessionPayload | null> {
  if (!token || !secret || secret.length < 16) {
    return null;
  }
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf('.')) {
    return null;
  }

  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  const sigBytes = fromBase64Url(sigB64);
  if (!sigBytes) {
    return null;
  }

  try {
    const enc = new TextEncoder();
    const key = await importHmacKey(secret);
    const sigCopy = new Uint8Array(sigBytes.length);
    sigCopy.set(sigBytes);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigCopy,
      enc.encode(payloadB64)
    );
    if (!valid) {
      return null;
    }

    const payloadBytes = fromBase64Url(payloadB64);
    if (!payloadBytes) {
      return null;
    }
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    if (
      !parsed ||
      typeof parsed.sub !== 'number' ||
      typeof parsed.username !== 'string' ||
      (parsed.role !== undefined && parsed.role !== 'admin' && parsed.role !== 'user') ||
      typeof parsed.ver !== 'number' ||
      typeof parsed.csrf !== 'string' ||
      (parsed.stage !== 'full' && parsed.stage !== 'totp_pending') ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (parsed.exp <= nowSec) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

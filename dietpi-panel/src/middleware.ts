import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from './lib/session-token';

const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/totp',
  '/api/health',
]);

function buildRedirectUrl(request: NextRequest, targetPath: string): URL {
  const rawHost =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    request.nextUrl.host;
  const host = rawHost.split(',')[0].trim();
  const protoHeader = request.headers.get('x-forwarded-proto');
  const proto = protoHeader
    ? protoHeader.split(',')[0].trim()
    : host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http'
      : 'https';
  return new URL(targetPath, `${proto}://${host}`);
}

function noStoreRedirect(request: NextRequest, targetPath: string): NextResponse {
  const res = NextResponse.redirect(buildRedirectUrl(request, targetPath));
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  return res;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    PUBLIC_API_PATHS.has(pathname)
  ) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET || '';
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token, secret);
  const isAuthenticated = Boolean(payload && payload.stage === 'full');

  if (pathname === '/login') {
    if (isAuthenticated && payload) {
      const dest = payload.mustChangePassword ? '/settings' : '/';
      return noStoreRedirect(request, dest);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    if (!isAuthenticated) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store, private' } }
      );
    }
    return NextResponse.next();
  }

  if (!isAuthenticated || !payload) {
    return noStoreRedirect(request, '/login');
  }

  if (payload.mustChangePassword && pathname !== '/settings') {
    return noStoreRedirect(request, '/settings');
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from './lib/session-token';

const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/totp',
  '/api/health',
]);

const ADMIN_ONLY_PAGE_PREFIXES = ['/users', '/services', '/logs', '/settings'];

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

function applyNoStoreHeaders(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.headers.set('CDN-Cache-Control', 'no-store');
  res.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  return res;
}

function noStoreRedirect(request: NextRequest, targetPath: string): NextResponse {
  return applyNoStoreHeaders(NextResponse.redirect(buildRedirectUrl(request, targetPath)));
}

export async function proxy(request: NextRequest) {
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
      const dest = payload.mustChangePassword ? '/account' : '/';
      return noStoreRedirect(request, dest);
    }
    return applyNoStoreHeaders(NextResponse.next());
  }

  if (pathname.startsWith('/api/')) {
    if (!isAuthenticated) {
      return applyNoStoreHeaders(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      );
    }
    return applyNoStoreHeaders(NextResponse.next());
  }

  if (!isAuthenticated || !payload) {
    return noStoreRedirect(request, '/login');
  }

  if (payload.mustChangePassword && pathname !== '/account') {
    return noStoreRedirect(request, '/account');
  }

  if (
    payload.role === 'user' &&
    ADMIN_ONLY_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return noStoreRedirect(request, '/');
  }

  return applyNoStoreHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

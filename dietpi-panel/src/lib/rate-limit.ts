interface AttemptEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const store = new Map<string, AttemptEntry>();

function pruneExpired(now: number): void {
  if (store.size < 250) return;
  for (const [k, entry] of store.entries()) {
    if (entry.resetAt <= now) {
      store.delete(k);
    }
  }
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    // Apache mod_proxy / local cloudflared append hops on the right; strip trailing loopback hops
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (!LOOPBACK_IPS.has(parts[i])) {
        return parts[i];
      }
    }
  }
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) {
    return cfIp.trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  return '127.0.0.1';
}

export function checkRateLimit(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
} {
  const now = Date.now();
  pruneExpired(now);
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0, remaining: MAX_ATTEMPTS };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, MAX_ATTEMPTS - entry.count),
  };
}

export function recordRateLimitFailure(key: string): void {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function resetRateLimit(key: string): void {
  store.delete(key);
}

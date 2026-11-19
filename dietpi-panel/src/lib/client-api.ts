export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (res.status === 401) {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Unauthorized', 401);
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };

  if (!res.ok) {
    if (
      res.status === 403 &&
      data.code === 'PASSWORD_CHANGE_REQUIRED' &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/settings'
    ) {
      window.location.href = '/settings';
    }
    throw new ApiError(
      data.error || `Request failed (${res.status})`,
      res.status,
      data.code
    );
  }

  return data as T;
}

export async function apiMutate<T>(
  url: string,
  method: 'POST' | 'DELETE' | 'PUT' | 'PATCH',
  csrfToken: string,
  body?: unknown
): Promise<T> {
  const doFetch = (token: string) =>
    fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'x-panel-csrf': token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch(csrfToken);

  if (res.status === 403) {
    const firstErr = (await res.clone().json().catch(() => ({}))) as {
      error?: string;
    };
    if (firstErr.error?.includes('x-panel-csrf')) {
      const meRes = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (meRes.ok) {
        const meJson = (await meRes.json().catch(() => ({}))) as {
          csrfToken?: string;
        };
        if (meJson.csrfToken && meJson.csrfToken !== csrfToken) {
          res = await doFetch(meJson.csrfToken);
        }
      }
    }
  }

  if (res.status === 401) {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Session expired. Please sign in again.', 401);
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };

  if (!res.ok) {
    throw new ApiError(
      data.error || `Request failed (${res.status})`,
      res.status,
      data.code
    );
  }

  return data as T;
}

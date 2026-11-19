export const NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const UNIT_RE = /^[a-zA-Z0-9@_.-]{1,64}$/;
export const GIT_URL_RE =
  /^(?:https:\/\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=%-]+|git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+)$/;
export const GIT_BRANCH_RE = /^[a-zA-Z0-9._/-]{1,64}$/;
export const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const SITE_TYPES = [
  'static',
  'php',
  'laravel',
  'react',
  'vue',
  'astro',
  'sveltekit',
  'nextjs',
  'node',
  'python',
] as const;
export type SiteType = (typeof SITE_TYPES)[number];

export interface FrameworkPresetInfo {
  type: SiteType;
  label: string;
  hasPort: boolean;
  summary: string;
  pipeline: string;
}

export const FRAMEWORK_PRESETS: Record<SiteType, FrameworkPresetInfo> = {
  static: {
    type: 'static',
    label: 'Static HTML',
    hasPort: false,
    summary: 'HTML/CSS/JS served directly from /var/www/<name>',
    pipeline: 'No build command required',
  },
  php: {
    type: 'php',
    label: 'PHP 8.x',
    hasPort: false,
    summary: 'Apache + PHP 8.x docroot at /var/www/<name>',
    pipeline: 'php -l syntax check on index.php',
  },
  laravel: {
    type: 'laravel',
    label: 'Laravel',
    hasPort: false,
    summary: 'Apache DocumentRoot at /var/www/<name>/public + SQLite .env',
    pipeline: 'composer install -> npm build (if present) -> artisan migrate & cache',
  },
  react: {
    type: 'react',
    label: 'React (Vite / SPA)',
    hasPort: false,
    summary: 'Apache serves dist/ with SPA FallbackResource /index.html',
    pipeline: 'npm ci/install -> npm run build',
  },
  vue: {
    type: 'vue',
    label: 'Vue (Vite / SPA)',
    hasPort: false,
    summary: 'Apache serves dist/ with SPA FallbackResource /index.html',
    pipeline: 'npm ci/install -> npm run build',
  },
  astro: {
    type: 'astro',
    label: 'Astro (Static)',
    hasPort: false,
    summary: 'Apache serves static dist/ output',
    pipeline: 'npm ci/install -> npm run build',
  },
  sveltekit: {
    type: 'sveltekit',
    label: 'SvelteKit (Static)',
    hasPort: false,
    summary: 'Apache serves build/ with SPA FallbackResource /index.html',
    pipeline: 'npm ci/install -> npm run build',
  },
  nextjs: {
    type: 'nextjs',
    label: 'Next.js',
    hasPort: true,
    summary: 'Reverse proxy to local Node port + systemd service',
    pipeline: 'npm ci/install -> npm run build -> systemctl restart app-<name>',
  },
  node: {
    type: 'node',
    label: 'Node.js Server',
    hasPort: true,
    summary: 'Express/Fastify/Node reverse proxy + systemd service',
    pipeline: 'npm ci/install -> npm run build (if defined) -> systemctl restart app-<name>',
  },
  python: {
    type: 'python',
    label: 'Python (Flask / FastAPI)',
    hasPort: true,
    summary: 'Reverse proxy to .venv app.py + systemd service',
    pipeline: 'python3 -m venv .venv -> pip install -r requirements.txt -> systemctl restart app-<name>',
  },
};

export const RESERVED_NAMES = new Set([
  'panel',
  'dietpi-panel',
  'backups',
  'www',
  'localhost',
  'default',
  'shared',
]);

export function validateResourceName(
  raw: unknown,
  label = 'name'
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `${label} must be a string` };
  }
  const value = raw.trim();
  if (!NAME_RE.test(value)) {
    return {
      ok: false,
      error: `Invalid ${label}: use 1-32 lowercase letters, digits, or hyphens`,
    };
  }
  if (RESERVED_NAMES.has(value)) {
    return { ok: false, error: `"${value}" is a reserved name` };
  }
  return { ok: true, value };
}

export function validateDomainName(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Domain must be a string' };
  }
  const value = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(value)) {
    return { ok: false, error: 'Invalid domain name format' };
  }
  return { ok: true, value };
}

export function validateSiteType(
  raw: unknown
): { ok: true; value: SiteType } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !SITE_TYPES.includes(raw as SiteType)) {
    return {
      ok: false,
      error: `Site type must be one of: ${SITE_TYPES.join(', ')}`,
    };
  }
  return { ok: true, value: raw as SiteType };
}

export function validateUnitName(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Unit name must be a string' };
  }
  const trimmed = raw.trim().replace(/\.service$/, '');
  if (!UNIT_RE.test(trimmed)) {
    return { ok: false, error: 'Invalid systemd unit name' };
  }
  return { ok: true, value: trimmed };
}

export function validateRelativePath(
  raw: unknown,
  allowEmpty = false
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return allowEmpty
      ? { ok: true, value: '' }
      : { ok: false, error: 'Path is required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Path must be a string' };
  }
  const normalized = raw.replace(/\\/g, '/').trim();
  if (normalized.includes('\0') || normalized.startsWith('/')) {
    return { ok: false, error: 'Invalid relative path' };
  }
  const parts = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((p) => p === '..')) {
    return { ok: false, error: 'Path traversal is not permitted' };
  }
  const clean = parts.join('/');
  if (!clean && !allowEmpty) {
    return { ok: false, error: 'File or folder path cannot be empty' };
  }
  return { ok: true, value: clean };
}

export function validateGitUrl(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Repository URL must be a string' };
  }
  const val = raw.trim();
  if (!val || val.startsWith('-') || !GIT_URL_RE.test(val)) {
    return { ok: false, error: 'Use a valid https:// or git@ repository URL' };
  }
  return { ok: true, value: val };
}

export function validateGitBranch(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Branch must be a string' };
  }
  const val = raw.trim();
  if (val.startsWith('-') || !GIT_BRANCH_RE.test(val)) {
    return { ok: false, error: 'Invalid branch name' };
  }
  return { ok: true, value: val };
}

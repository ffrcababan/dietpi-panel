export const NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const UNIT_RE = /^[a-zA-Z0-9@_.-]{1,64}$/;
export const SITE_TYPES = ['static', 'php', 'nextjs'] as const;
export type SiteType = (typeof SITE_TYPES)[number];

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
    return { ok: false, error: 'Site type must be static, php, or nextjs' };
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

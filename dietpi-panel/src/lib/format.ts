import type { TunnelActionResult } from './agent';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatTunnelSummary(
  tunnel?: TunnelActionResult
): { ok: boolean; text: string } | null {
  if (!tunnel || !tunnel.enabled) return null;
  if (tunnel.error) {
    return {
      ok: false,
      text: `Cloudflare Tunnel warning (${tunnel.hostname || 'host'}): ${tunnel.error}`,
    };
  }
  const parts: string[] = [];
  if (tunnel.dns && tunnel.dns !== 'skipped') parts.push(`DNS ${tunnel.dns}`);
  if (tunnel.ingress && tunnel.ingress !== 'skipped') parts.push(`ingress ${tunnel.ingress}`);
  if (tunnel.restartScheduled) parts.push('cloudflared restarting in 2s');
  const warnText = tunnel.warnings?.length ? ` (${tunnel.warnings.join('; ')})` : '';
  return {
    ok: tunnel.dns !== 'failed',
    text: `Tunnel ${tunnel.hostname || ''}: ${parts.join(', ') || 'unchanged'}${warnText}`.trim(),
  };
}

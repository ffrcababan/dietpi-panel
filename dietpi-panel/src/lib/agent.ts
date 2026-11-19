import net from 'node:net';

export type AgentAction =
  | 'ping'
  | 'stats'
  | 'db.create'
  | 'db.list'
  | 'db.delete'
  | 'site.create'
  | 'site.list'
  | 'site.delete'
  | 'service.list'
  | 'service.status'
  | 'service.restart'
  | 'logs'
  | 'cert'
  | 'tunnel.route'
  | 'files.list'
  | 'files.read'
  | 'files.write'
  | 'files.upload'
  | 'files.uploadStart'
  | 'files.uploadChunk'
  | 'files.uploadFinish'
  | 'files.mkdir'
  | 'files.rename'
  | 'files.delete'
  | 'site.git'
  | 'site.build'
  | 'site.buildStatus'
  | 'site.watch'
  | 'activity.list';

export interface BuildStepResult {
  cmd: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SiteBuildRecord {
  name: string;
  type: string;
  trigger: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  steps: BuildStepResult[];
  queued?: boolean;
}

export interface TunnelActionResult {
  enabled: boolean;
  reason?: string;
  hostname?: string;
  service?: string;
  tunnel?: string;
  dns?: string;
  ingress?: string;
  restartScheduled?: boolean;
  warnings?: string[];
  error?: string;
}

export interface AgentResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function callControlAgent(
  action: AgentAction,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<AgentResponse> {
  const socketPath = process.env.AGENT_SOCKET || '/run/control-agent.sock';
  const secret = process.env.AGENT_SECRET || '';

  if (!secret || secret.length < 16) {
    throw new Error('Server misconfiguration: AGENT_SECRET is not set');
  }

  const effectiveTimeout =
    timeoutMs ??
    (action === 'files.write' ||
    action === 'files.upload' ||
    action === 'files.uploadFinish' ||
    action === 'site.git' ||
    action === 'site.build'
      ? 305_000
      : action === 'cert' ||
          action === 'tunnel.route' ||
          action === 'site.create' ||
          action === 'db.create'
        ? 125_000
        : 30_000);

  return new Promise<AgentResponse>((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;

    const finishErr = (msg: string) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(msg));
    };

    const finishOk = (resp: AgentResponse) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(resp);
    };

    client.setTimeout(effectiveTimeout);

    client.on('connect', () => {
      const payload = JSON.stringify({ secret, action, params }) + '\n';
      client.write(payload);
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        try {
          const parsed = JSON.parse(line) as AgentResponse;
          finishOk({
            ok: Boolean(parsed.ok),
            stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
            stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
          });
        } catch {
          finishErr('Malformed response from control agent');
        }
      }
    });

    client.on('end', () => {
      if (!settled) {
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim()) as AgentResponse;
            finishOk({
              ok: Boolean(parsed.ok),
              stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
              stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
            });
            return;
          } catch {
            // fall through
          }
        }
        finishErr('Control agent closed connection unexpectedly');
      }
    });

    client.on('timeout', () => {
      finishErr(`Control agent request timed out (${action})`);
    });

    client.on('error', (err) => {
      finishErr(`Control agent unavailable: ${err.message}`);
    });
  });
}

export function parseAgentJson<T>(resp: AgentResponse, fallbackError: string): T {
  if (!resp.ok) {
    throw new Error(resp.stderr || fallbackError);
  }
  try {
    return JSON.parse(resp.stdout || 'null') as T;
  } catch {
    throw new Error(fallbackError);
  }
}

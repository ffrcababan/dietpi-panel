import { NextResponse } from 'next/server';
import { callControlAgent, parseAgentJson } from '@/lib/agent';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export interface ServiceRecord {
  unit: string;
  activeState: string;
  subState: string;
  loadState: string;
  description: string;
  active: boolean;
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const resp = await callControlAgent('service.list');
    const services = parseAgentJson<ServiceRecord[]>(
      resp,
      'Failed to fetch service list'
    );
    return NextResponse.json({ services });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list services' },
      { status: 502 }
    );
  }
}

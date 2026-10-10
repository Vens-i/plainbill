import type {
  AgingChart,
  BalanceRow,
  DenialsChart,
  Kpis,
  PracticeInfo,
} from '@plainbill/api/contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      body.error ?? 'error',
      body.message ?? `Request failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  practice: () => getJson<PracticeInfo>('/practice'),
  balances: () => getJson<BalanceRow[]>('/balances'),
  kpis: () => getJson<Kpis>('/kpis'),
  agingChart: () => getJson<AgingChart>('/charts/aging'),
  denialsChart: () => getJson<DenialsChart>('/charts/denials-by-payer'),
};

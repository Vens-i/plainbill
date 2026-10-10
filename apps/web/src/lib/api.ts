import type {
  AgingChart,
  BalanceRow,
  DenialsChart,
  DraftMessageResult,
  DrawerData,
  IntakeApproveResult,
  IntakeBatchView,
  Kpis,
  MessageVariant,
  PaymentOption,
  PracticeInfo,
  SendResult,
} from '@plainbill/api/contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      details?: string[];
    };
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? `Request failed (${res.status})`,
      err.details ?? [],
    );
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>('GET', path);

export interface DraftInput {
  message: string;
  messageSource: 'ai' | 'template' | 'edited';
  paymentOption: PaymentOption;
}

export const api = {
  practice: () => get<PracticeInfo>('/practice'),
  balances: () => get<BalanceRow[]>('/balances'),
  kpis: () => get<Kpis>('/kpis'),
  agingChart: () => get<AgingChart>('/charts/aging'),
  denialsChart: () => get<DenialsChart>('/charts/denials-by-payer'),

  intakeBatch: () => get<{ batch: IntakeBatchView | null }>('/intake/batch'),
  uploadIntakeFile: (file: File) => {
    const form = new FormData();
    form.append('files', file, file.name);
    return request<{ batch: IntakeBatchView }>('POST', '/intake/files', form);
  },
  intakeSamples: (files: string[]) =>
    request<{ batch: IntakeBatchView }>('POST', '/dev/intake-samples', { files }),
  resolveIntakeFlag: (itemId: number, path: string, value: string) =>
    request<{ batch: IntakeBatchView | null }>('PATCH', `/intake/items/${itemId}/flags`, {
      path,
      value,
    }),
  approveIntake: () => request<IntakeApproveResult>('POST', '/intake/batch/approve'),
  discardIntake: () => request<{ batch: null }>('POST', '/intake/batch/discard'),

  drawer: (id: number) => get<DrawerData>(`/balances/${id}/drawer`),
  draftMessage: (id: number, variant: MessageVariant, paymentOption: PaymentOption) =>
    request<DraftMessageResult>('POST', `/balances/${id}/message`, { variant, paymentOption }),
  saveDraft: (id: number, draft: DraftInput) =>
    request<DrawerData>('PUT', `/balances/${id}/draft`, draft),
  send: (id: number, draft: DraftInput) =>
    request<SendResult>('POST', `/balances/${id}/send`, draft),
  resolveReviewFlag: (id: number, path: string, value: string) =>
    request<DrawerData>('POST', `/balances/${id}/review/resolve`, { path, value }),
  markReady: (id: number) => request<DrawerData>('POST', `/balances/${id}/review/ready`),
};

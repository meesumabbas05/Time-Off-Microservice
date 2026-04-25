export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'DEAD_LETTER';
export type OutboxType = 'HCM_DEDUCT' | 'HCM_CREDIT';

export interface OutboxEventLike {
  id: string;
  tenant_id: string;
  event_type: OutboxType;
  status: OutboxStatus;
  attempt_count: number;
  idempotency_key: string;
  payload: Record<string, any>;
  created_at?: Date;
}

export interface HcmClientLike {
  deduct(tenantId: string, payload: Record<string, any>, idempotencyKey: string): Promise<any>;
  credit(tenantId: string, payload: Record<string, any>, idempotencyKey: string): Promise<any>;
}

export interface AlertLike {
  notify(code: string, payload: Record<string, any>): void;
}

export class OutboxWorker {
  constructor(
    private readonly hcmClient: HcmClientLike,
    private readonly alertService: AlertLike,
  ) {}

  async processEvent(event: OutboxEventLike): Promise<any> {
    try {
      const resp = await (event.event_type === 'HCM_DEDUCT' 
        ? this.hcmClient.deduct(event.tenant_id, event.payload, event.idempotency_key)
        : this.hcmClient.credit(event.tenant_id, event.payload, event.idempotency_key));

      event.status = 'DONE';
      // axios response structure might differ, but we expect hcm_request_id in data if success
      return resp?.data?.hcm_request_id || resp?.hcm_request_id;
    } catch (error: any) {
      event.attempt_count += 1;

      const statusCode = error?.statusCode ?? error?.response?.status;
      const isRetriable = !statusCode || (statusCode >= 500 && statusCode < 600) || statusCode === 429;

      if (!isRetriable || event.attempt_count >= 5) {
        event.status = 'DEAD_LETTER';
        this.alertService.notify('HCM_DEAD_LETTER', { eventId: event.id, error: error.message });
        return;
      }

      event.status = 'PENDING';
      throw error; // Rethrow to let service know it failed
    }
  }
}

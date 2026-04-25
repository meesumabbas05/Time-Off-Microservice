export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'DEAD_LETTER';
export type OutboxType = 'HCM_DEDUCT' | 'HCM_CREDIT';

export interface OutboxEventLike {
  id: string;
  event_type: OutboxType;
  status: OutboxStatus;
  attempt_count: number;
  idempotency_key: string;
  payload: Record<string, any>;
  created_at?: Date;
}

export interface HcmClientLike {
  deduct(payload: Record<string, any>, headers: Record<string, string>): Promise<{ hcm_request_id?: string }>;
  credit(payload: Record<string, any>, headers: Record<string, string>): Promise<{ hcm_request_id?: string }>;
}

export interface AlertLike {
  notify(code: string, payload: Record<string, any>): void;
}

export class OutboxWorker {
  constructor(
    private readonly hcmClient: HcmClientLike,
    private readonly alertService: AlertLike,
  ) {}

  async processEvents(events: OutboxEventLike[]): Promise<OutboxEventLike[]> {
    const pending = events
      .filter((e) => e.status === 'PENDING')
      .sort((a, b) => (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0));

    for (const event of pending) {
      await this.processEvent(event);
    }

    return events;
  }

  async processEvent(event: OutboxEventLike): Promise<void> {
    const headers = { 'X-Idempotency-Key': event.idempotency_key };

    try {
      const result = await (event.event_type === 'HCM_DEDUCT' 
        ? this.hcmClient.deduct(event.payload, headers)
        : this.hcmClient.credit(event.payload, headers));

      event.status = 'DONE';
      return result?.hcm_request_id;
    } catch (error: any) {
      event.attempt_count += 1;

      const statusCode = error?.statusCode ?? error?.response?.status;
      const isRetriable = !statusCode || statusCode >= 500;

      if (!isRetriable || event.attempt_count >= 5) {
        event.status = 'DEAD_LETTER';
        this.alertService.notify('HCM_DEAD_LETTER', { eventId: event.id });
        return;
      }

      event.status = 'PENDING';
    }
  }
}

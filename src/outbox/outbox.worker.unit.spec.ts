import { OutboxWorker, OutboxEventLike } from './outbox.worker';

describe('OutboxWorker', () => {
  const mockHcmClient = {
    deduct: jest.fn(),
    credit: jest.fn(),
  };

  const mockAlert = {
    notify: jest.fn(),
  };

  let worker: OutboxWorker;

  beforeEach(() => {
    worker = new OutboxWorker(mockHcmClient as any, mockAlert);
    jest.clearAllMocks();
  });

  const tenantId = 't1';

  it('UT-OBX-001 — picks up PENDING events and calls correct HCM operation', async () => {
    const events: OutboxEventLike[] = [
      { id: '1', tenant_id: tenantId, event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {} },
      { id: '2', tenant_id: tenantId, event_type: 'HCM_CREDIT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k2', payload: {} },
    ];
    mockHcmClient.deduct.mockResolvedValue({});
    mockHcmClient.credit.mockResolvedValue({});

    for (const e of events) {
      await worker.processEvent(e);
    }

    expect(mockHcmClient.deduct).toHaveBeenCalledWith(tenantId, {}, 'k1');
    expect(mockHcmClient.credit).toHaveBeenCalledWith(tenantId, {}, 'k2');
    expect(events[0].status).toBe('DONE');
    expect(events[1].status).toBe('DONE');
  });

  it('UT-OBX-002 — increments attempt_count on retriable HCM error and does not mark DONE', async () => {
    const event: OutboxEventLike = {
      id: '1', tenant_id: tenantId, event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ response: { status: 503 } });

    await worker.processEvent(event).catch(() => {});

    expect(event.attempt_count).toBe(1);
    expect(event.status).toBe('PENDING');
  });

  it('UT-OBX-003 — marks event DEAD_LETTER after 5 failed attempts', async () => {
    const event: OutboxEventLike = {
      id: '1', tenant_id: tenantId, event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 4, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ response: { status: 503 } });

    await worker.processEvent(event);

    expect(event.attempt_count).toBe(5);
    expect(event.status).toBe('DEAD_LETTER');
    expect(mockAlert.notify).toHaveBeenCalledWith('HCM_DEAD_LETTER', expect.any(Object));
  });

  it('UT-OBX-004 — uses idempotency key on each HCM call', async () => {
    const event: OutboxEventLike = {
      id: '1', tenant_id: tenantId, event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'KEY-123', payload: {},
    };
    mockHcmClient.deduct.mockResolvedValue({});

    await worker.processEvent(event);

    expect(mockHcmClient.deduct).toHaveBeenCalledWith(tenantId, {}, 'KEY-123');
  });

  it('UT-OBX-008 — marks request DEAD_LETTER on non-retriable HCM error (4xx)', async () => {
    const event: OutboxEventLike = {
      id: '1', tenant_id: tenantId, event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ response: { status: 422 } });

    await worker.processEvent(event);

    expect(event.status).toBe('DEAD_LETTER');
    expect(mockAlert.notify).toHaveBeenCalled();
  });
});

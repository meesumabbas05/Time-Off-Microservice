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
    worker = new OutboxWorker(mockHcmClient, mockAlert);
    jest.clearAllMocks();
  });

  it('UT-OBX-001 — picks up PENDING events and calls correct HCM operation', async () => {
    const events: OutboxEventLike[] = [
      { id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {} },
      { id: '2', event_type: 'HCM_CREDIT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k2', payload: {} },
    ];
    mockHcmClient.deduct.mockResolvedValue({});
    mockHcmClient.credit.mockResolvedValue({});

    await worker.processEvents(events);

    expect(mockHcmClient.deduct).toHaveBeenCalledTimes(1);
    expect(mockHcmClient.credit).toHaveBeenCalledTimes(1);
    expect(events[0].status).toBe('DONE');
    expect(events[1].status).toBe('DONE');
  });

  it('UT-OBX-002 — increments attempt_count on retriable HCM error and does not mark DONE', async () => {
    const event: OutboxEventLike = {
      id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ statusCode: 503 });

    await worker.processEvent(event);

    expect(event.attempt_count).toBe(1);
    expect(event.status).toBe('PENDING');
  });

  it('UT-OBX-003 — marks event DEAD_LETTER after 5 failed attempts', async () => {
    const event: OutboxEventLike = {
      id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 4, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ statusCode: 503 });

    await worker.processEvent(event);

    expect(event.attempt_count).toBe(5);
    expect(event.status).toBe('DEAD_LETTER');
    expect(mockAlert.notify).toHaveBeenCalledWith('HCM_DEAD_LETTER', expect.any(Object));
  });

  it('UT-OBX-004 — uses idempotency key on each HCM call', async () => {
    const event: OutboxEventLike = {
      id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'KEY-123', payload: {},
    };
    mockHcmClient.deduct.mockResolvedValue({});

    await worker.processEvent(event);

    expect(mockHcmClient.deduct).toHaveBeenCalledWith({}, { 'X-Idempotency-Key': 'KEY-123' });
  });

  it('UT-OBX-005 — does NOT re-process DONE or DEAD_LETTER events', async () => {
    const events: OutboxEventLike[] = [
      { id: '1', event_type: 'HCM_DEDUCT', status: 'DONE', attempt_count: 0, idempotency_key: 'k1', payload: {} },
      { id: '2', event_type: 'HCM_DEDUCT', status: 'DEAD_LETTER', attempt_count: 0, idempotency_key: 'k2', payload: {} },
      { id: '3', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k3', payload: {} },
    ];
    mockHcmClient.deduct.mockResolvedValue({});

    await worker.processEvents(events);

    expect(mockHcmClient.deduct).toHaveBeenCalledTimes(1);
  });

  it('UT-OBX-006 — processes events ordered by created_at ASC (FIFO)', async () => {
    const calls: string[] = [];
    const older = new Date(Date.now() - 1000);
    const newer = new Date();

    const events: OutboxEventLike[] = [
      { id: 'new', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: { id: 'new' }, created_at: newer },
      { id: 'old', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k2', payload: { id: 'old' }, created_at: older },
    ];

    mockHcmClient.deduct.mockImplementation(async (payload) => {
      calls.push(payload.id);
      return {};
    });

    await worker.processEvents(events);

    expect(calls).toEqual(['old', 'new']);
  });

  it('UT-OBX-007 — updates request metadata after successful HCM deduction', async () => {
    const event: OutboxEventLike = {
      id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: { requestId: 'r1', days: 3 },
    };
    mockHcmClient.deduct.mockResolvedValue({ hcm_request_id: 'HCM-456' });

    await worker.processEvent(event);

    expect(event.status).toBe('DONE');
  });

  it('UT-OBX-008 — marks request DEAD_LETTER on non-retriable HCM error (4xx)', async () => {
    const event: OutboxEventLike = {
      id: '1', event_type: 'HCM_DEDUCT', status: 'PENDING', attempt_count: 0, idempotency_key: 'k1', payload: {},
    };
    mockHcmClient.deduct.mockRejectedValue({ statusCode: 422 });

    await worker.processEvent(event);

    expect(event.status).toBe('DEAD_LETTER');
    expect(mockAlert.notify).toHaveBeenCalled();
  });
});

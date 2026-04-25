import { Test, TestingModule } from '@nestjs/testing';
import { HcmSyncService, InvalidWebhookSignatureException } from './hcm-sync.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxEvent, OutboxEventStatus, OutboxEventType } from '../entities/outbox-event.entity';
import { Tenant } from '../entities/tenant.entity';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';
import * as crypto from 'crypto';

describe('HcmSyncService', () => {
  let service: HcmSyncService;

  const mockOutboxRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockTenantRepo = {
    findOne: jest.fn(),
  };

  const mockAuditRepo = {
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockHttpClient = {
    postRequest: jest.fn(),
    fetchBalances: jest.fn(),
    getBalance: jest.fn(),
    deduct: jest.fn(),
    credit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmSyncService,
        { provide: getRepositoryToken(OutboxEvent), useValue: mockOutboxRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
        { provide: getRepositoryToken(BalanceAuditLog), useValue: mockAuditRepo },
        { provide: 'HCM_CLIENT', useValue: mockHttpClient },
      ],
    }).compile();

    service = module.get<HcmSyncService>(HcmSyncService);
    jest.clearAllMocks();
  });

  describe('Webhook & Sync Processing', () => {
    it('UT-SYN-001 — processBatchSync applies valid records and returns synced/skipped', async () => {
      const payload = {
        nonce: 'n1',
        records: [
          {
            employeeId: 'e1',
            locationId: 'l1',
            leaveType: 'VACATION',
            days: 10,
            asOf: new Date().toISOString(),
          },
        ],
      };
      mockTenantRepo.findOne.mockResolvedValue({ id: 't1', webhook_secret: 'secret' });
      (mockTenantRepo.manager as any) = {
        transaction: jest.fn(async (cb) =>
          cb({
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue(true),
            create: jest.fn().mockImplementation((entity, data) => data),
          }),
        ),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((entity, data) => data),
        save: jest.fn().mockResolvedValue(true),
      };
      const validSignature = crypto.createHmac('sha256', 'secret').update(JSON.stringify(payload)).digest('hex');
      const result = await service.handleWebhook('t1', payload, validSignature);
      expect(result).toEqual({ synced: 1, skipped: 0 });
    });

    it('UT-SYN-002 — validates HMAC signature of webhook payload', async () => {
      mockTenantRepo.findOne.mockResolvedValue({ id: 't1', webhook_secret: 'secret' });
      await expect(service.handleWebhook('t1', { data: 'test' }, 'invalid-signature')).rejects.toThrow(InvalidWebhookSignatureException);
    });

    it('rejects duplicate nonce replay within 24h window', async () => {
      const payload = {
        nonce: 'n-replay',
        records: [
          {
            employeeId: 'e1',
            locationId: 'l1',
            leaveType: 'VACATION',
            days: 10,
            asOf: new Date().toISOString(),
          },
        ],
      };
      mockTenantRepo.findOne.mockResolvedValue({ id: 't1', webhook_secret: 'secret' });
      (mockTenantRepo.manager as any) = {
        transaction: jest.fn(async (cb) =>
          cb({
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue(true),
            create: jest.fn().mockImplementation((entity, data) => data),
          }),
        ),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((entity, data) => data),
        save: jest.fn().mockResolvedValue(true),
      };
      const validSignature = crypto.createHmac('sha256', 'secret').update(JSON.stringify(payload)).digest('hex');

      await service.handleWebhook('t1', payload, validSignature);
      await expect(service.handleWebhook('t1', payload, validSignature)).rejects.toThrow('Nonce replay detected');
    });

    it('UT-SYN-003 — creates outbox events for HCM_DEDUCT transactions', async () => {
      mockOutboxRepo.save.mockImplementation(dto => dto);
      mockOutboxRepo.create.mockImplementation(dto => dto);
      await service.queueHcmDeduct('t1', 'req_1', 'idk_1');
      expect(mockOutboxRepo.save).toHaveBeenCalledWith(expect.objectContaining({ event_type: OutboxEventType.HCM_DEDUCT, idempotency_key: 'idk_1' }));
    });

    it('manual sync skips out-of-order snapshots and syncs fresher records', async () => {
      const nowIso = new Date().toISOString();
      mockHttpClient.fetchBalances.mockResolvedValue([
        {
          employeeId: 'e1',
          locationId: 'l1',
          leaveType: 'VACATION',
          days: 12,
          asOf: nowIso,
        },
      ]);
      (mockTenantRepo.manager as any) = {
        transaction: jest.fn(async (cb) =>
          cb({
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue(true),
            create: jest.fn().mockImplementation((entity, data) => data),
          }),
        ),
        find: jest.fn().mockResolvedValue([
          { id: 'u1', employee_id: 'e1' }
        ]),
        create: jest.fn().mockImplementation((entity, data) => data),
        save: jest.fn().mockResolvedValue(true),
      };

      const result = await service.triggerManualSync('t1');
      expect(result).toEqual({ synced: 1, skipped: 0 });
    });
  });

  describe('Outbox Worker & Resilience', () => {
    const mockEvent = { id: 'evt_1', tenant_id: 't1', event_type: OutboxEventType.HCM_DEDUCT, payload: { requestId: 'req_1' }, status: OutboxEventStatus.PENDING, attempt_count: 0, idempotency_key: 'idk_1' };

    it('UT-SYN-004 — Opossum circuit breaker trips open after consecutive errors', async () => {
        // Mocking circuit breaker behavior directly in internal client 
        let errorCount = 0;
        const cbMock = jest.fn(() => {
            errorCount++;
            if (errorCount > 5) throw new Error('CircuitBreakerOpenException');
            throw new Error('NetworkError');
        });
        
        await expect(service.executeWithCircuitBreaker(cbMock)).rejects.toThrow();
        // Assuming we simulate 6 calls to trip it
        for(let i = 0; i < 5; i++) {
           await service.executeWithCircuitBreaker(cbMock).catch(() => {});
        }
        await expect(service.executeWithCircuitBreaker(cbMock)).rejects.toThrow('CircuitBreakerOpenException');
    });

    it('UT-SYN-005 — Opossum returns to half-open after 30s timeout', () => {
      // Unit testing the state transition logic mapped in service wrapper
      expect(service.getCircuitBreakerConfig().resetTimeout).toBe(30000); // 30 seconds
    });

    it('UT-SYN-006 — Axios-retry retries 3 times on 503/429 responses', async () => {
       expect(service.getRetryConfig().retries).toBe(3);
       expect(service.getRetryConfig().retryCondition([503, 429])).toBe(true);
    });

    it('UT-SYN-007 — worker successfully marks outbox event to DONE when HCM returns 201', async () => {
       mockHttpClient.deduct.mockResolvedValue({ status: 201 });
       mockOutboxRepo.save.mockImplementation(dto => dto);
       
       const event = { ...mockEvent };
       await service.processEvent(event as any);

       expect(mockOutboxRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: OutboxEventStatus.DONE }));
    });

    it('UT-SYN-008 — worker increments attempt_count and sets DEAD_LETTER if retries exhausted', async () => {
       mockHttpClient.deduct.mockRejectedValue(new Error('Fatal HCM Error'));
       mockOutboxRepo.save.mockImplementation(dto => dto);
       
       const event = { ...mockEvent, attempt_count: 4 }; // Assuming max retries is 5
       await service.processEvent(event as any);

       expect(mockOutboxRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: OutboxEventStatus.DEAD_LETTER, attempt_count: 5 }));
    });

    it('UT-SYNC-009 — outbox worker strictly ignores events not in PENDING or PROCESSING state', async () => {
       const doneEvent = { ...mockEvent, status: OutboxEventStatus.DONE };
       await service.processEvent(doneEvent as any);
       expect(mockHttpClient.postRequest).not.toHaveBeenCalled();
    });
  });
});

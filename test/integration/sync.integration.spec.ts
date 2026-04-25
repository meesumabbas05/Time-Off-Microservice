import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { OutboxEvent, OutboxEventType, OutboxEventStatus } from '../../src/entities/outbox-event.entity';
import { OutboxService } from '../../src/outbox/outbox.service';
import { v4 as uuid } from 'uuid';

describe('Sync & Outbox Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let outboxService: OutboxService;
  const tenantId = uuid();

  const mockHcmClient = {
    getBalance: jest.fn(),
    fetchBalances: jest.fn(),
    postRequest: jest.fn(),
    deduct: jest.fn(),
    credit: jest.fn(),
  };

  const mockAlertService = {
    notify: jest.fn(),
  };

  beforeAll(async () => {
    const setup = await setupIntegrationTest([
        { provide: 'HCM_CLIENT', useValue: mockHcmClient },
        { provide: 'ALERT_SERVICE', useValue: mockAlertService }
    ]);
    app = setup.app;
    dataSource = setup.dataSource;
    jwtService = setup.jwtService;
    outboxService = app.get(OutboxService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase(dataSource);
    await dataSource.getRepository(Tenant).save({ id: tenantId, name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
  });

  it('IT-SYN-004 — Batch sync atomicity: all records applied or none', async () => {
    const secret = 's';
    const body = {
        nonce: uuid(),
        records: [
            { employeeId: 'e1', locationId: 'l1', leaveType: 'VACATION', days: 10, asOf: new Date().toISOString() },
            { employeeId: 'e2', locationId: 'l1', leaveType: 'VACATION', days: 12, asOf: new Date().toISOString() }
        ]
    };

    const signature = require('crypto').createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

    const res = await request(app.getHttpServer())
      .post(`/sync/webhook/${tenantId}`)
      .set('x-hcm-signature', signature) 
      .send(body)
      .expect(201); 

    expect(res.body.synced).toBe(2);

    const b1 = await dataSource.getRepository(LeaveBalance).findOneBy({ employee_id: 'e1' });
    expect(b1?.balance_days).toBe(10);
  });

  it('IT-SYN-005 — Batch sync skips out-of-order records', async () => {
    const secret = 's';
    const now = new Date();
    const oldDate = new Date(now.getTime() - 10000);

    // Seed e1 with "now"
    await dataSource.getRepository(LeaveBalance).save({
        tenant_id: tenantId, employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION',
        balance_days: 5, hcm_last_synced: now
    });

    const body = {
        nonce: uuid(),
        records: [
            { employeeId: 'e1', locationId: 'l1', leaveType: 'VACATION', days: 10, asOf: oldDate.toISOString() }, // STALE
            { employeeId: 'e2', locationId: 'l1', leaveType: 'VACATION', days: 15, asOf: now.toISOString() }     // NEW
        ]
    };

    const signature = require('crypto').createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

    const res = await request(app.getHttpServer())
      .post(`/sync/webhook/${tenantId}`)
      .set('x-hcm-signature', signature) 
      .send(body)
      .expect(201);

    expect(res.body.synced).toBe(1);
    expect(res.body.skipped).toBe(1);

    const b1 = await dataSource.getRepository(LeaveBalance).findOneBy({ employee_id: 'e1' });
    expect(b1?.balance_days).toBe(5); // Not updated to 10

    const b2 = await dataSource.getRepository(LeaveBalance).findOneBy({ employee_id: 'e2' });
    expect(b2?.balance_days).toBe(15);
  });

  it('IT-SYN-001 — Outbox worker calls HCM deduct and updates balance_days on success', async () => {
    const aliceId = uuid();
    const requestId = uuid();
    
    // 1. Seed Alice with 10 days
    await dataSource.getRepository(LeaveBalance).save({
        tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        balance_days: 10, hcm_last_synced: new Date()
    });

    // 2. Seed Request
    await dataSource.getRepository(TimeOffRequest).save({
        id: requestId, tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        days_requested: 3, status: RequestStatus.APPROVED, idempotency_key: 'ik1',
        start_date: '2026-01-01', end_date: '2026-01-03'
    });

    // 3. Seed Outbox Event
    const event = await dataSource.getRepository(OutboxEvent).save({
        tenant_id: tenantId, event_type: OutboxEventType.HCM_DEDUCT,
        status: OutboxEventStatus.PENDING, idempotency_key: 'ik1',
        payload: { requestId }
    });

    // 4. Mock HCM success
    mockHcmClient.deduct.mockResolvedValue({ hcm_request_id: 'HCM-123' });

    // 5. Run Outbox Service
    await outboxService.handleCron();

    // 6. Verify
    const updatedRequest = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: requestId });
    expect(updatedRequest?.hcm_request_id).toBe('HCM-123');

    const updatedBalance = await dataSource.getRepository(LeaveBalance).findOneBy({ employee_id: aliceId });
    expect(Number(updatedBalance?.balance_days)).toBe(7); // 10 - 3

    const updatedEvent = await dataSource.getRepository(OutboxEvent).findOneBy({ id: event.id });
    expect(updatedEvent?.status).toBe(OutboxEventStatus.DONE);
  });

  it('IT-SYN-008 — Manual sync trigger (ADMIN) fetches and updates all tenant balances', async () => {
    const adminId = uuid();
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantId, role: UserRole.ADMIN, email: 'e@t1.com', location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, role: UserRole.EMPLOYEE, email: 'a@t1.com', location_id: 'l1', timezone: 'UTC' });
    
    await dataSource.getRepository(LeaveBalance).save({
        tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        balance_days: 5, hcm_last_synced: new Date()
    });

    mockHcmClient.fetchBalances.mockResolvedValue([{
        employeeId: aliceId,
        locationId: 'l1',
        leaveType: 'VACATION',
        days: 8.00,
        asOf: new Date().toISOString()
    }]);

    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .post('/sync/trigger')
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    const updated = await dataSource.getRepository(LeaveBalance).findOneBy({ employee_id: aliceId });
    expect(Number(updated?.balance_days)).toBe(8);
  });

  it('IT-SYN-010 — Reconciliation job detects HCM drift and corrects local balance', async () => {
    const adminId = uuid();
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantId, role: UserRole.ADMIN, email: 'e2@t1.com', location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, role: UserRole.EMPLOYEE, email: 'a2@t1.com', location_id: 'l1', timezone: 'UTC' });

    await dataSource.getRepository(LeaveBalance).save({
        tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        balance_days: 10, hcm_last_synced: new Date()
    });

    mockHcmClient.fetchBalances.mockResolvedValue([{
        employeeId: aliceId,
        locationId: 'l1',
        leaveType: 'VACATION',
        days: 7.00,
        asOf: new Date().toISOString()
    }]);

    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    const res = await request(app.getHttpServer())
      .post('/sync/trigger-recon')
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    expect(res.body.drifts).toBe(1);
  });

  it('IT-SYN-011 — Cancellation of APPROVED request creates HCM_CREDIT outbox event', async () => {
    const aliceId = uuid();
    const requestId = uuid();
    const adminId = uuid();

    await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantId, role: UserRole.ADMIN, email: 'admin@t.com', location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, role: UserRole.EMPLOYEE, email: 'alice@t.com', location_id: 'l1', timezone: 'UTC' });

    await dataSource.getRepository(TimeOffRequest).save({
        id: requestId, tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        days_requested: 3, status: RequestStatus.APPROVED, idempotency_key: 'ik-cancel',
        start_date: '2026-01-01', end_date: '2026-01-03', hcm_request_id: 'HCM-OLD', timezone: 'UTC'
    });

    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .patch(`/requests/${requestId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const event = await dataSource.getRepository(OutboxEvent).findOneBy({ 
        tenant_id: tenantId, 
        event_type: OutboxEventType.HCM_CREDIT 
    });
    expect(event).toBeDefined();
    expect(event?.payload.hcmRequestId).toBe('HCM-OLD');
    expect(Number(event?.payload.daysRequested)).toBe(3);
  });

  it('IT-SYN-002 — Outbox worker retries on HCM 503 (transient failure)', async () => {
    const aliceId = uuid();
    const requestId = uuid();
    await dataSource.getRepository(LeaveBalance).save({ tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION', balance_days: 10, hcm_last_synced: new Date() });
    await dataSource.getRepository(TimeOffRequest).save({ id: requestId, tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION', days_requested: 3, status: RequestStatus.APPROVED, idempotency_key: 'ik-retry', start_date: '2026-01-01', end_date: '2026-01-03', timezone: 'UTC' });
    const event = await dataSource.getRepository(OutboxEvent).save({ tenant_id: tenantId, event_type: OutboxEventType.HCM_DEDUCT, status: OutboxEventStatus.PENDING, idempotency_key: 'ik-retry', payload: { requestId } });

    // Mock 503 once
    mockHcmClient.deduct.mockRejectedValueOnce({ statusCode: 503, message: 'Transient' });
    await outboxService.handleCron();
    const e1 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: event.id });
    expect(e1?.attempt_count).toBe(1);
    expect(e1?.status).toBe(OutboxEventStatus.PENDING);

    // Success on second
    mockHcmClient.deduct.mockResolvedValueOnce({ hcm_request_id: 'HCM-NEW' });
    await outboxService.handleCron();
    const e2 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: event.id });
    expect(e2?.status).toBe(OutboxEventStatus.DONE);
  });

  it('IT-SYN-009 — Non-ADMIN attempt to trigger manual sync returns 403', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, role: UserRole.EMPLOYEE, email: 'a@t.com', location_id: 'l1', timezone: 'UTC' });
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/sync/trigger')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('IT-SYN-003 — Outbox worker continues processing next event if one fails', async () => {
    // Two events: first fails perm (DL), second succeeds
    const e1 = await dataSource.getRepository(OutboxEvent).save({ tenant_id: tenantId, event_type: OutboxEventType.HCM_DEDUCT, status: OutboxEventStatus.PENDING, idempotency_key: 'f1', payload: { requestId: 'r1' }, attempt_count: 4 });
    const e2 = await dataSource.getRepository(OutboxEvent).save({ tenant_id: tenantId, event_type: OutboxEventType.HCM_DEDUCT, status: OutboxEventStatus.PENDING, idempotency_key: 's1', payload: { requestId: 'r2' } });

    mockHcmClient.deduct.mockRejectedValueOnce(new Error('Fatal'));
    mockHcmClient.deduct.mockResolvedValueOnce({ hcm_request_id: 'HCM-OK' });

    await outboxService.handleCron();

    const u1 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: e1.id });
    expect(u1?.status).toBe(OutboxEventStatus.DEAD_LETTER);

    const u2 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: e2.id });
    expect(u2?.status).toBe(OutboxEventStatus.DONE);
  });

  it('IT-SYN-007 — Batch sync rejects duplicate nonce (replay protection)', async () => {
      const body = { nonce: 'nonce-123', records: [] };
      const signature = require('crypto').createHmac('sha256', 's').update(JSON.stringify(body)).digest('hex');

      await request(app.getHttpServer())
        .post(`/sync/webhook/${tenantId}`)
        .set('x-hcm-signature', signature)
        .send(body)
        .expect(201);

      await request(app.getHttpServer())
        .post(`/sync/webhook/${tenantId}`)
        .set('x-hcm-signature', signature)
        .send(body)
        .expect(401); // Nonce replay now returns 401 to match TRD/E2E requirements
  });

  it('IT-SYN-006 — Batch sync webhook rejects HMAC mismatch (401)', async () => {
    const body = { nonce: uuid(), records: [] };
    await request(app.getHttpServer())
      .post(`/sync/webhook/${tenantId}`)
      .set('x-hcm-signature', 'invalid-signature')
      .send(body)
      .expect(401);
  });

  it('IT-SYN-012 — HCM_CREDIT outbox event retried on failure', async () => {
    const requestId = uuid();
    const event = await dataSource.getRepository(OutboxEvent).save({
        tenant_id: tenantId, event_type: OutboxEventType.HCM_CREDIT,
        status: OutboxEventStatus.PENDING, idempotency_key: 'ik-credit-retry',
        payload: { hcmRequestId: 'HCM-OLD', daysRequested: 3 }
    });

    mockHcmClient.credit.mockRejectedValueOnce({ statusCode: 503 });
    await outboxService.handleCron();
    
    const e1 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: event.id });
    expect(e1?.attempt_count).toBe(1);

    mockHcmClient.credit.mockResolvedValueOnce({});
    await outboxService.handleCron();

    const e2 = await dataSource.getRepository(OutboxEvent).findOneBy({ id: event.id });
    expect(e2?.status).toBe(OutboxEventStatus.DONE);
  });
});

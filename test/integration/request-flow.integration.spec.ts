import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { OutboxEvent } from '../../src/entities/outbox-event.entity';
import { BalanceAuditLog } from '../../src/entities/balance-audit-log.entity';

describe('Request Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  beforeAll(async () => {
    const setup = await setupIntegrationTest();
    app = setup.app;
    dataSource = setup.dataSource;
    jwtService = setup.jwtService;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase(dataSource);
  });

  it('IT-SUB-001 — can submit a request and then approve it (happy path)', async () => {
    // 1. Seed
    const tenant = await dataSource.getRepository(Tenant).save({
      id: 't1',
      name: 'Tenant 1',
      webhook_secret: 'secret',
      hcm_base_url: 'http://hcm.test',
      hcm_api_key: 'test-key'
    });
    const manager = await dataSource.getRepository(User).save({
      id: 'mgr1',
      employee_id: 'mgr1',
      tenant_id: 't1',
      email: 'mgr@t1.com',
      role: UserRole.MANAGER,
      location_id: 'l1',
      timezone: 'UTC'
    });
    const alice = await dataSource.getRepository(User).save({
      id: 'alice',
      employee_id: 'alice',
      tenant_id: 't1',
      email: 'alice@t1.com',
      role: UserRole.EMPLOYEE,
      location_id: 'l1',
      timezone: 'UTC',
      manager_id: 'mgr1'
    });
    
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1',
      employee_id: 'alice',
      location_id: 'l1',
      leave_type: 'VACATION',
      balance_days: 10.00,
      hcm_last_synced: new Date()
    });

    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: 'EMPLOYEE' });
    const mgrToken = generateTestToken(jwtService, { userId: 'mgr1', tenantId: 't1', role: 'MANAGER' });

    // 2. Submit
    const submitResp = await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        locationId: 'l1',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-05',
        timezone: 'UTC',
        days_requested: 5
      })
      .expect(202);

    const requestId = submitResp.body.id;
    expect(requestId).toBeDefined();

    // 3. Approve
    await request(app.getHttpServer())
      .patch(`/requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ managerId: 'mgr1' })
      .expect(200);

    // 4. Verify DB
    const reqRecord = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: requestId });
    expect(reqRecord?.status).toBe(RequestStatus.APPROVED);
  });

  it('IT-SEC-001 — blocks request from another tenant', async () => {
     // Scenario: User from Tenant 2 tries to approve a request from Tenant 1
     const t1 = await dataSource.getRepository(Tenant).save({
        id: 't1',
        name: 'T1',
        webhook_secret: 's1',
        hcm_base_url: 'http://hcm1.test',
        hcm_api_key: 'k1'
     });
     const t2 = await dataSource.getRepository(Tenant).save({
        id: 't2',
        name: 'T2',
        webhook_secret: 's2',
        hcm_base_url: 'http://hcm2.test',
        hcm_api_key: 'k2'
     });
     
     const alice = await dataSource.getRepository(User).save({
        id: 'alice',
        employee_id: 'alice',
        tenant_id: 't1',
        email: 'a@t1.com',
        role: UserRole.EMPLOYEE,
        location_id: 'l1',
        timezone: 'UTC'
     });
     const hacker = await dataSource.getRepository(User).save({
        id: 'hacker',
        employee_id: 'hacker',
        tenant_id: 't2',
        email: 'h@t2.com',
        role: UserRole.MANAGER,
        location_id: 'l1',
        timezone: 'UTC'
     });

     // Alice from T1 has a request
     const aliceRequest = await dataSource.getRepository(TimeOffRequest).save({
        tenant_id: 't1',
        employee_id: 'alice',
        location_id: 'l1',
        leave_type: 'VACATION',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        days_requested: 1,
        status: RequestStatus.PENDING_APPROVAL,
        idempotency_key: 'key1'
     });

     const hackerToken = generateTestToken(jwtService, { userId: 'hacker', tenantId: 't2', role: 'MANAGER' });

     await request(app.getHttpServer())
       .patch(`/requests/${aliceRequest.id}/approve`)
       .set('Authorization', `Bearer ${hackerToken}`)
       .send({ managerId: 'hacker' })
       .expect(403); // Ownership guard should fail because hacker doesn't manage Alice and they are different tenants anyway
  });
  it('IT-SUB-002 — rejects submission when balance insufficient', async () => {
     await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
     await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
     
     await dataSource.getRepository(LeaveBalance).save({
       tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
       balance_days: 1.00, hcm_last_synced: new Date()
     });

     const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

     await request(app.getHttpServer())
       .post('/requests')
       .set('Authorization', `Bearer ${aliceToken}`)
       .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-05', timezone: 'UTC', days_requested: 5 })
       .expect(422); // Insufficient balance
  });

  it('IT-SUB-003 — rejects when 10 pending requests already exist', async () => {
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 100.00, hcm_last_synced: new Date()
    });

    for(let i=0; i<10; i++) {
        await dataSource.getRepository('time_off_requests').save({
            tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
            start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
            status: RequestStatus.PENDING_APPROVAL, idempotency_key: `key-${i}`
        });
    }

    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-02-01', endDate: '2026-02-02', timezone: 'UTC', days_requested: 1 })
      .expect(429); // Too many pending requests
  });

  it('IT-CON-001 — serialization prevents double-spending in race condition', async () => {
    // This is hard to "guarantee" a race in supertest without a sleep in the service,
    // but we can simulate the scenario: 
    // Two requests come in for the same balance (10 days). Each asks for 6 days.
    // Both should not be approved.
    
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'mgr', employee_id: 'mgr', tenant_id: 't1', email: 'm@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', manager_id: 'mgr' });
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const req1 = await dataSource.getRepository('time_off_requests').save({
        tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-07', days_requested: 6,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r1'
    });
    const req2 = await dataSource.getRepository('time_off_requests').save({
        tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-02-01', end_date: '2026-02-07', days_requested: 6,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r2'
    });

    const mgrToken = generateTestToken(jwtService, { userId: 'mgr', tenantId: 't1', role: UserRole.MANAGER });

    // Execute in parallel
    const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).patch(`/requests/${req1.id}/approve`).set('Authorization', `Bearer ${mgrToken}`).send({ managerId: 'mgr' }),
        request(app.getHttpServer()).patch(`/requests/${req2.id}/approve`).set('Authorization', `Bearer ${mgrToken}`).send({ managerId: 'mgr' })
    ]);

    // One should succeed, the other should fail with 409 (Conflict) due to balance re-validation
    const results = [res1.status, res2.status];
    expect(results).toContain(200);
    expect(results).toContain(409);
  });
  it('IT-CAN-001 — allows employee to cancel their PENDING request', async () => {
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const requestRecord = await dataSource.getRepository(TimeOffRequest).save({
        tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c1'
    });

    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${requestRecord.id}/cancel`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const updated = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: requestRecord.id });
    expect(updated?.status).toBe(RequestStatus.CANCELLED);
  });

  it('IT-CAN-002 — blocks cancellation of an already APPROVED request', async () => {
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const requestRecord = await dataSource.getRepository(TimeOffRequest).save({
        tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
        status: RequestStatus.APPROVED, idempotency_key: 'c2'
    });

    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${requestRecord.id}/cancel`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(409); // InvalidStateTransitionException
  });

  it('IT-SYNC-001 — verifies OutboxEvent creation after successful approval', async () => {
    // Happy path already exists, but let's confirm the outbox specifically
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'mgr', employee_id: 'mgr', tenant_id: 't1', email: 'm@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', manager_id: 'mgr' });
    await dataSource.getRepository(LeaveBalance).save({ tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION', balance_days: 10 });

    const req = await dataSource.getRepository(TimeOffRequest).save({
        tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 's1'
    });

    const mgrToken = generateTestToken(jwtService, { userId: 'mgr', tenantId: 't1', role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ managerId: 'mgr' })
      .expect(200);

    const event = await dataSource.getRepository(OutboxEvent).findOneBy({ tenant_id: 't1' });
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({ requestId: req.id });
  });

  it('IT-AUDIT-001 — verifies audit log on balance refresh (internal logic test via controller)', async () => {
    // We can trigger refresh by getting balance if it's stale
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    // Seed stale balance
    await dataSource.getRepository(LeaveBalance).save({
       tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
       balance_days: 5.0, hcm_last_synced: new Date(Date.now() - 3600000) // 1 hr ago
    });

    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    // Mock HCM_CLIENT to return 7 days
    // We'd need to mock it in the testing module, but our BalanceModule already has a stub.
    // Let's assume the stub returns 10 (as I set in BalanceModule provider)
    
    await request(app.getHttpServer())
      .get(`/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const audit = await dataSource.getRepository(BalanceAuditLog).findOneBy({ employee_id: 'alice' });
    expect(audit).toBeDefined();
    expect(Number(audit?.new_days)).toBe(10);
  });
});

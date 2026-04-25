import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { v4 as uuid } from 'uuid';

describe('Security & Access Control (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  const tenantA = uuid();
  const tenantB = uuid();

  const mockHcmClient = {
    getBalance: jest.fn().mockResolvedValue({ days: 10, asOf: new Date().toISOString() }),
    deduct: jest.fn().mockResolvedValue({ hcm_request_id: 'HCM-123' }),
  };

  beforeAll(async () => {
    const setup = await setupIntegrationTest([{ provide: 'HCM_CLIENT', useValue: mockHcmClient }]);
    app = setup.app;
    dataSource = setup.dataSource;
    jwtService = setup.jwtService;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase(dataSource);
    await dataSource.getRepository(Tenant).save({ id: tenantA, name: 'T1', webhook_secret: 's1', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(Tenant).save({ id: tenantB, name: 'T2', webhook_secret: 's2', hcm_base_url: 'u', hcm_api_key: 'k' });
  });

  it('IT-SEC-001 — EMPLOYEE cannot access MANAGER-only endpoint', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch('/requests/any-id/approve')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('IT-SEC-002 — MANAGER can access their reportee data but not other team data', async () => {
      const bobId = uuid(); 
      const aliceId = uuid(); 
      const charlieId = uuid();
      
      await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantA, role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC', email: 'b@t1.com' });
      await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, manager_id: bobId, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'a@t1.com' });
      await dataSource.getRepository(User).save({ id: charlieId, employee_id: charlieId, tenant_id: tenantA, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'c@t1.com' });

      const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantA, role: UserRole.MANAGER });

      await request(app.getHttpServer())
        .get(`/requests?employeeId=${aliceId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .get(`/requests?employeeId=${charlieId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
  });

  it('IT-SEC-013 — Mass assignment: non-whitelisted fields are rejected (400)', async () => {
      const aliceId = uuid();
      await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'a@t1.com' });
      const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

      await request(app.getHttpServer())
        .post('/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-02', timezone: 'UTC', status: 'APPROVED' })
        .expect(400);
  });

  it('IT-SEC-009 — Tenant Isolation: User from Tenant A cannot see data in Tenant B', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const bobId = uuid();
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantB, email: 'b@t2.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .get(`/requests?employeeId=${bobId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403); 
  });

  it('IT-SEC-003 — Self-approval branch check: manager cannot approve own request', async () => {
    const bobId = uuid();
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantA, role: UserRole.MANAGER, email: 'b@t1.com', location_id: 'l1', timezone: 'UTC' });
    
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantA, employee_id: bobId, location_id: 'l1', timezone: 'UTC', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: uuid()
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantA, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(403);
  });

  it('IT-SEC-006 — Cross-tenant via Request ID: Alice (T1) cannot approve Bob (T2) request', async () => {
    const aliceId = uuid(); 
    const bobId = uuid();
    const bobReqId = uuid();

    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, role: UserRole.MANAGER, email: 'a@t1.com', location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantB, role: UserRole.EMPLOYEE, email: 'b@t2.com', location_id: 'l1', timezone: 'UTC' });

    await dataSource.getRepository(TimeOffRequest).save({
        id: bobReqId, tenant_id: tenantB, employee_id: bobId, location_id: 'l1', timezone: 'UTC', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: uuid()
    });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${bobReqId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403); 
  });

  it('IT-SEC-011 — Batch sync signature mismatch is rejected (401)', async () => {
      const body = { nonce: 'n1', records: [] };
      await request(app.getHttpServer())
        .post(`/sync/webhook/${tenantA}`)
        .set('x-hcm-signature', 'wrong')
        .send(body)
        .expect(401);
  });

  it('IT-SEC-004 — MANAGER cannot approve request for non-reportee', async () => {
      const bobId = uuid(); 
      const charlieId = uuid(); 
      const charlieReqId = uuid();

      await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantA, role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC', email: 'b@t.com' });
      await dataSource.getRepository(User).save({ id: charlieId, employee_id: charlieId, tenant_id: tenantA, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'c@t.com' });

      await dataSource.getRepository(TimeOffRequest).save({
          id: charlieReqId, tenant_id: tenantA, employee_id: charlieId, location_id: 'l1', timezone: 'UTC', leave_type: 'VACATION',
          start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
          status: RequestStatus.PENDING_APPROVAL, idempotency_key: uuid()
      });

      const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantA, role: UserRole.MANAGER });

      await request(app.getHttpServer())
        .patch(`/requests/${charlieReqId}/approve`)
        .set('Authorization', `Bearer ${token}`)
        .send({ managerId: bobId })
        .expect(403);
  });

  it('IT-SEC-014 — ADMIN cannot read data from another tenant', async () => {
      const adminId = uuid(); 
      const bobId = uuid(); 
      
      await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantA, role: UserRole.ADMIN, email: 'admin@t1.com', location_id: 'l1', timezone: 'UTC' });
      await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantB, role: UserRole.EMPLOYEE, email: 'b@t2.com', location_id: 'l1', timezone: 'UTC' });

      const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantA, role: UserRole.ADMIN });

      await request(app.getHttpServer())
        .get(`/requests?employeeId=${bobId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403); 
  });

  it('IT-SEC-008 — Audit Log Access: Only ADMIN can view balance audit logs', async () => {
      const aliceId = uuid();
      await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, role: UserRole.EMPLOYEE, email: 'a3@t1.com', location_id: 'l1', timezone: 'UTC' });
      const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

      await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
  });

  it('IT-SEC-005 — [ATTACK] Employee submits request with another employee\'s ID in body → 400 (Mass Assignment)', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'a4@t1.com' });
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: 'CHARLIE_ID', locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-02', timezone: 'UTC' })
      .expect(400); // Because employeeId is not in CreateTimeOffRequestDto (whitelisted) and forbidNonWhitelisted is true
  });

  it('IT-SEC-015 — [ATTACK] Rate limit flooding: 11+ submissions per minute returns 429', async () => {
      const aliceId = uuid();
      await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantA, role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', email: 'a5@t1.com' });
      await dataSource.getRepository('leave_balances').save({ tenant_id: tenantA, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION', balance_days: 100 });
      const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantA, role: UserRole.EMPLOYEE });

      // First 10
      for(let i=0; i<10; i++) {
          await request(app.getHttpServer())
            .post('/requests')
            .set('Authorization', `Bearer ${token}`)
            .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-02', timezone: 'UTC', days_requested: 1 })
            .expect(202);
      }

      // 11th
      await request(app.getHttpServer())
        .post('/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-02', timezone: 'UTC', days_requested: 1 })
        .expect(429);
  });

  it('IT-SEC-016 — Invalid JWT secret rejected (401)', async () => {
     const token = jwtService.sign({ userId: 'any', tenantId: tenantA, role: UserRole.EMPLOYEE }, { secret: 'WRONG_SECRET' });
     await request(app.getHttpServer())
       .get('/requests')
       .set('Authorization', `Bearer ${token}`)
       .expect(401);
  });
});

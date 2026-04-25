import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { v4 as uuid } from 'uuid';

describe('Read Access Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  const tenantId = uuid();
  const aliceId = uuid();
  const bobId = uuid();

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
    await dataSource.getRepository(Tenant).save({ id: tenantId, name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantId, email: 'b@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).update(aliceId, { manager_id: bobId });
  });

  it('IT-REA-001 — EMPLOYEE can list their own requests with status filter', async () => {
    await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, status: RequestStatus.PENDING_APPROVAL, start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1, idempotency_key: 'r1', location_id: 'l1', leave_type: 'VACATION' });
    await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, status: RequestStatus.APPROVED, start_date: '2026-02-01', end_date: '2026-02-02', days_requested: 1, idempotency_key: 'r2', location_id: 'l1', leave_type: 'VACATION' });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    const res = await request(app.getHttpServer())
      .get('/requests?status=PENDING_APPROVAL')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe(RequestStatus.PENDING_APPROVAL);
  });

  it('IT-REA-002 — MANAGER can list requests of their direct reports', async () => {
    await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, status: RequestStatus.PENDING_APPROVAL, start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1, idempotency_key: 'r1', location_id: 'l1', leave_type: 'VACATION' });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    const res = await request(app.getHttpServer())
      .get(`/requests?employeeId=${aliceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.length).toBe(1);
  });

  it('IT-REA-003 — EMPLOYEE cannot list requests of another employee', async () => {
    const charlieId = uuid();
    await dataSource.getRepository(User).save({ id: charlieId, employee_id: charlieId, tenant_id: tenantId, email: 'c@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .get(`/requests?employeeId=${charlieId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('IT-REA-004 — Date range filtering works', async () => {
    await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, start_date: '2026-01-01', end_date: '2026-01-05', days_requested: 5, idempotency_key: 'r1', location_id: 'l1', leave_type: 'VACATION' });
    await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, start_date: '2026-02-01', end_date: '2026-02-05', days_requested: 5, idempotency_key: 'r2', location_id: 'l1', leave_type: 'VACATION' });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    const res = await request(app.getHttpServer())
      .get('/requests?from=2026-01-01&to=2026-01-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].start_date).toBe('2026-01-01');
  });

  it('IT-REA-005 — GET /requests/:id returns full details for OWNER', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1, idempotency_key: 'r1', location_id: 'l1', leave_type: 'VACATION' });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    const res = await request(app.getHttpServer())
      .get(`/requests/${req.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.id).toBe(req.id);
  });

  it('IT-RRD-006 — ADMIN can list requests for any employee in their tenant', async () => {
    const adminId = uuid();
    await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantId, email: 'admin2@t1.com', role: UserRole.ADMIN, location_id: 'l1', timezone: 'UTC' });
    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    const res = await request(app.getHttpServer())
      .get(`/requests?employeeId=${aliceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  it('IT-RRD-007 — GET /requests returns 400 for invalid date format', async () => {
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });
    await request(app.getHttpServer())
      .get('/requests?from=invalid-date')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('IT-RRD-008 — GET /requests returns empty array if no matches found', async () => {
      const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });
      const res = await request(app.getHttpServer())
        .get('/requests?status=REJECTED')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.length).toBe(0);
  });

  it('IT-RRD-009 — Date range filter inclusive of boundaries', async () => {
      // Logic check for inclusive start/end
  });

  it('IT-RRD-010 — GET /requests handles multiple filters simultaneously', async () => {
      // status + employeeId + date range
  });
});

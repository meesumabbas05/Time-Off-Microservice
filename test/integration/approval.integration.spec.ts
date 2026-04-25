import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { OutboxEvent, OutboxEventType } from '../../src/entities/outbox-event.entity';
import { v4 as uuid } from 'uuid';

describe('Approval Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  
  // Use unique UUIDs that look like business IDs too
  const aliceId = uuid();
  const bobId = uuid();
  const charlieId = uuid();
  const tenantId = uuid();
  
  const mockHcmClient = {
    getBalance: jest.fn(),
    postRequest: jest.fn(),
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
    jest.clearAllMocks();
    mockHcmClient.getBalance.mockResolvedValue({ days: 20, asOf: new Date().toISOString() });
    await seedApprovalData();
  });

  async function seedApprovalData() {
    await dataSource.getRepository(Tenant).save({ id: tenantId, name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantId, email: 'b@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', manager_id: bobId });
    await dataSource.getRepository(User).save({ id: charlieId, employee_id: charlieId, tenant_id: tenantId, email: 'c@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
  }

  it('IT-APR-001 — Happy path: manager approves request', async () => {
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r1'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(200);

    const updated = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: req.id });
    expect(updated?.status).toBe(RequestStatus.APPROVED);
    expect(updated?.decided_by).toBe(bobId);
  });

  it('IT-APR-002 — Manager rejects request', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r2'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Team conflict' })
      .expect(200);

    const updated = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: req.id });
    expect(updated?.status).toBe(RequestStatus.REJECTED);
  });

  it('IT-APR-003 — Employee cannot approve their own request', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: bobId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r3'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(403);
  });

  it('IT-APR-005 — Approval of non-existent request returns 404', async () => {
    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${uuid()}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(404);
  });

  it('IT-APR-006 — Approval of already-APPROVED request returns 409', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
        status: RequestStatus.APPROVED, idempotency_key: 'r6'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(409);
  });

  it('IT-APR-007 — Approval triggers HCM freshness re-check when balance is stale', async () => {
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000)
    });

    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r7'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(200);

    expect(mockHcmClient.getBalance).toHaveBeenCalled();
  });

  it('IT-APR-010 — Approval-time re-validation reads live aggregate', async () => {
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        status: RequestStatus.APPROVED, days_requested: 3, idempotency_key: 'p1',
        start_date: '2026-01-01', end_date: '2026-01-02'
    });
    await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        status: RequestStatus.APPROVED, days_requested: 3, idempotency_key: 'p2',
        start_date: '2026-01-03', end_date: '2026-01-04'
    });

    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        status: RequestStatus.PENDING_APPROVAL, days_requested: 5, idempotency_key: 'r10',
        start_date: '2026-01-05', end_date: '2026-01-06'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: bobId })
      .expect(409); 
  });
});

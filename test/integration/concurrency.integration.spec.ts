import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { v4 as uuid } from 'uuid';

describe('Concurrency & Serialization (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  const tenantId = uuid();
  const bobId = uuid();
  const charlieId = uuid();

  beforeAll(async () => {
    // We override HCM_CLIENT with a dummy to prevent crashes in refreshFromHcm
    const setup = await setupIntegrationTest([
        { provide: 'HCM_CLIENT', useValue: { getBalance: async () => ({ days: 10, asOf: new Date() }), postRequest: async () => ({ status: 201 }) } }
    ]);
    app = setup.app;
    dataSource = setup.dataSource;
    jwtService = setup.jwtService;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase(dataSource);
    await seedCharlie();
  });

  async function seedCharlie() {
    await dataSource.getRepository(Tenant).save({ id: tenantId, name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantId, email: 'b@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: charlieId, employee_id: charlieId, tenant_id: tenantId, email: 'c@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', manager_id: bobId });
  }

  it('IT-CON-001 — Two concurrent approval attempts are serialized; second fails with 409', async () => {
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION',
      balance_days: 3.00, hcm_last_synced: new Date()
    });

    const r1 = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 2,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r1'
    });
    const r2 = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-02-01', end_date: '2026-02-02', days_requested: 2,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r2'
    });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).patch(`/requests/${r1.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId }),
        request(app.getHttpServer()).patch(`/requests/${r2.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId })
    ]);

    const statusCodes = [res1.status, res2.status];
    expect(statusCodes).toContain(200);
    expect(statusCodes).toContain(409);
  });

  it('IT-CON-003 — Sequential approvals correctly decrement available balance', async () => {
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const r1 = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION', days_requested: 4, status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c1', start_date: '2026-01-01', end_date: '2026-01-02' });
    const r2 = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION', days_requested: 4, status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c2', start_date: '2026-01-03', end_date: '2026-01-04' });
    const r3 = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION', days_requested: 4, status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c3', start_date: '2026-01-05', end_date: '2026-01-06' });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    await request(app.getHttpServer()).patch(`/requests/${r1.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId }).expect(200);
    await request(app.getHttpServer()).patch(`/requests/${r2.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId }).expect(200);
    await request(app.getHttpServer()).patch(`/requests/${r3.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId }).expect(409);
  });

  it('IT-CON-004 — Concurrent approval attempts for different employees do not interfere', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC', manager_id: bobId });
    
    await dataSource.getRepository(LeaveBalance).save({ tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION', balance_days: 10, hcm_last_synced: new Date() });
    await dataSource.getRepository(LeaveBalance).save({ tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION', balance_days: 10, hcm_last_synced: new Date() });

    const r1 = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: charlieId, location_id: 'l1', leave_type: 'VACATION', days_requested: 5, status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r1', start_date: '2026-01-01', end_date: '2026-01-02' });
    const r2 = await dataSource.getRepository(TimeOffRequest).save({ id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION', days_requested: 5, status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'r2', start_date: '2026-01-01', end_date: '2026-01-02' });

    const token = generateTestToken(jwtService, { userId: bobId, tenantId: tenantId, role: UserRole.MANAGER });

    const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).patch(`/requests/${r1.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId }),
        request(app.getHttpServer()).patch(`/requests/${r2.id}/approve`).set('Authorization', `Bearer ${token}`).send({ managerId: bobId })
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});

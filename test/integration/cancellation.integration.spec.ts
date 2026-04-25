import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { v4 as uuid } from 'uuid';

describe('Cancellation Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  const tenantId = uuid();
  const aliceId = uuid();

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
  });

  it('IT-CAN-001 — Happy path: employee cancels their own pending request', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 2,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c1'
    });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const updated = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: req.id });
    expect(updated?.status).toBe(RequestStatus.CANCELLED);
  });

  it('IT-CAN-002 — Employee cannot cancel already APPROVED request (409)', async () => {
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 2,
        status: RequestStatus.APPROVED, idempotency_key: 'c2'
    });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('IT-CAN-003 — Employee cannot cancel another employee\'s request (403)', async () => {
    const bobId = uuid();
    await dataSource.getRepository(User).save({ id: bobId, employee_id: bobId, tenant_id: tenantId, email: 'b@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const req = await dataSource.getRepository(TimeOffRequest).save({
        id: uuid(), tenant_id: tenantId, employee_id: bobId, location_id: 'l1', leave_type: 'VACATION',
        start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 2,
        status: RequestStatus.PENDING_APPROVAL, idempotency_key: 'c3'
    });

    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${req.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('IT-CAN-004 — Cancellation of non-existent request (404)', async () => {
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch(`/requests/${uuid()}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('IT-CAN-005 — Cancelled request does not count towards 10-pending cap', async () => {
     // Seed 10 cancelled
     for (let i = 0; i < 10; i++) {
         await dataSource.getRepository(TimeOffRequest).save({
             tenant_id: tenantId, employee_id: aliceId, location_id: 'l1', leave_type: 'VACATION',
             status: RequestStatus.CANCELLED, days_requested: 1, idempotency_key: `k-${i}`,
             start_date: '2026-01-01', end_date: '2026-01-02'
         });
     }

     const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });
     
     await request(app.getHttpServer())
       .post('/requests')
       .set('Authorization', `Bearer ${token}`)
       .send({ locationId: 'l1', leaveType: 'VACATION', startDate: '2026-06-01', endDate: '2026-06-02', timezone: 'UTC', days_requested: 1 })
       .expect(202);
  });
});

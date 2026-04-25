import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';

describe('Submission Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
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
  });

  async function seedAlice() {
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
  }

  const validBody = {
    locationId: 'l1',
    leaveType: 'VACATION',
    startDate: '2026-06-01',
    endDate: '2026-06-03',
    timezone: 'UTC',
    days_requested: 3
  };

  it('IT-SUB-001 — Happy path: employee submits valid request', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const resp = await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(202);

    expect(resp.body).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(resp.body.id).toBeDefined();

    const record = await dataSource.getRepository(TimeOffRequest).findOneBy({ id: resp.body.id });
    expect(record?.employee_id).toBe('alice');
  });

  it('IT-SUB-002 — Submission with insufficient balance returns 422', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 1.00, hcm_last_synced: new Date()
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(422);
  });

  it('IT-SUB-003 — Submission triggers mandatory HCM freshness refresh when balance is stale', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 5.00, hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000) // 20 min ago
    });

    mockHcmClient.getBalance.mockResolvedValue({ days: 10.00, asOf: new Date().toISOString() });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(202);

    expect(mockHcmClient.getBalance).toHaveBeenCalled();
  });

  it('IT-SUB-004 — 10th pending request is accepted; 11th returns 429', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 100.00, hcm_last_synced: new Date()
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    // Seed 10 pending
    for (let i = 0; i < 10; i++) {
        await dataSource.getRepository(TimeOffRequest).save({
            tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
            start_date: '2026-01-01', end_date: '2026-01-02', days_requested: 1,
            status: RequestStatus.PENDING_APPROVAL, idempotency_key: `key-${i}`
        });
    }

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(429);
  });

  it('IT-SUB-005 — Submission with employeeId in body pointing to different employee', async () => {
    await seedAlice();
    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    // Assuming DTO doesn't have employeeId, but if someone tries to inject it
    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, employeeId: 'other' })
      .expect(400); // Because of forbidNonWhitelisted
  });

  it('IT-SUB-006 — Submission with unknown extra fields returns 400', async () => {
    await seedAlice();
    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, status: 'APPROVED' })
      .expect(400);
  });

  it('IT-SUB-007 — Two concurrent submissions both pass to PENDING_APPROVAL (no reservation)', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 5.00, hcm_last_synced: new Date()
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${token}`).send(validBody),
        request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${token}`).send(validBody)
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);
    
    const count = await dataSource.getRepository(TimeOffRequest).countBy({ employee_id: 'alice', status: RequestStatus.PENDING_APPROVAL });
    expect(count).toBe(2);
  });

  it('IT-SUB-008 — Submission with days_requested = 0 is rejected', async () => {
     await seedAlice();
     const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

     await request(app.getHttpServer())
       .post('/requests')
       .set('Authorization', `Bearer ${token}`)
       .send({ ...validBody, days_requested: 0 })
       .expect(400);
  });

  it('IT-SUB-009 — Employee cannot use the approve endpoint', async () => {
    await seedAlice();
    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .patch('/requests/any-id/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ managerId: 'alice' })
      .expect(403);
  });

  it('IT-SUB-010 — Submission response requestId is a valid UUID', async () => {
    await seedAlice();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const resp = await request(app.getHttpServer())
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(202);

    expect(resp.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

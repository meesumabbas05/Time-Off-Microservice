import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { BalanceAuditLog } from '../../src/entities/balance-audit-log.entity';

describe('Balance Lifecycle (Integration)', () => {
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

  async function seedBasicData() {
    await dataSource.getRepository(Tenant).save({ id: 't1', name: 'T1', webhook_secret: 's', hcm_base_url: 'u', hcm_api_key: 'k' });
    await dataSource.getRepository(User).save({ id: 'alice', employee_id: 'alice', tenant_id: 't1', email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: 'bob', employee_id: 'bob', tenant_id: 't1', email: 'b@t1.com', role: UserRole.MANAGER, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).save({ id: 'eve', employee_id: 'eve', tenant_id: 't1', email: 'e@t1.com', role: UserRole.ADMIN, location_id: 'l1', timezone: 'UTC' });
    await dataSource.getRepository(User).update('alice', { manager_id: 'bob' });
  }

  it('IT-BAL-001 — GET /balance/:employeeId returns cached balance with freshness metadata', async () => {
    await seedBasicData();
    const freshDate = new Date();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: freshDate
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const resp = await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(resp.body).toEqual({
      balance_days: 10,
      available_days: 10,
      hcm_last_synced: freshDate.toISOString(),
      isFresh: true
    });
    expect(mockHcmClient.getBalance).not.toHaveBeenCalled();
  });

  it('IT-BAL-002 — GET /balance/:employeeId?refresh=true forces live HCM fetch', async () => {
    await seedBasicData();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 5.00, hcm_last_synced: new Date()
    });

    mockHcmClient.getBalance.mockResolvedValue({ days: 8.00, asOf: new Date().toISOString() });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const resp = await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION&refresh=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(resp.body.balance_days).toBe(8);
    expect(mockHcmClient.getBalance).toHaveBeenCalled();
    
    const audit = await dataSource.getRepository(BalanceAuditLog).findOneBy({ employee_id: 'alice' });
    expect(audit).toBeDefined();
    expect(audit?.source).toBe('SPOT_SYNC');
  });

  it('IT-BAL-003 — GET /balance/:employeeId returns 401 with no JWT', async () => {
    await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION')
      .expect(401);
  });

  it('IT-BAL-004 — EMPLOYEE cannot read another employee\'s balance (403)', async () => {
    await seedBasicData();
    await dataSource.getRepository(User).save({ id: 'charlie', employee_id: 'charlie', tenant_id: 't1', email: 'c@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const aliceToken = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .get('/balance/charlie?tenantId=t1&locationId=l1&leaveType=VACATION')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(403);
  });

  it('IT-BAL-005 — MANAGER can read their own direct report\'s balance', async () => {
    await seedBasicData();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const bobToken = generateTestToken(jwtService, { userId: 'bob', tenantId: 't1', role: UserRole.MANAGER });

    await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(200);
  });

  it('IT-BAL-006 — ADMIN can read any employee\'s balance across the tenant', async () => {
    await seedBasicData();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    const eveToken = generateTestToken(jwtService, { userId: 'eve', tenantId: 't1', role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION')
      .set('Authorization', `Bearer ${eveToken}`)
      .expect(200);
  });

  it('IT-BAL-007 — GET /balance/:employeeId returns available_days minus approved-undeducted requests', async () => {
    await seedBasicData();
    await dataSource.getRepository(LeaveBalance).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      balance_days: 10.00, hcm_last_synced: new Date()
    });

    await dataSource.getRepository(TimeOffRequest).save({
      tenant_id: 't1', employee_id: 'alice', location_id: 'l1', leave_type: 'VACATION',
      start_date: '2026-01-01', end_date: '2026-01-03', days_requested: 3,
      status: RequestStatus.APPROVED, idempotency_key: 'req1'
    });

    const token = generateTestToken(jwtService, { userId: 'alice', tenantId: 't1', role: UserRole.EMPLOYEE });

    const resp = await request(app.getHttpServer())
      .get('/balance/alice?tenantId=t1&locationId=l1&leaveType=VACATION')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(resp.body.available_days).toBe(7);
    expect(resp.body.balance_days).toBe(10);
  });
});

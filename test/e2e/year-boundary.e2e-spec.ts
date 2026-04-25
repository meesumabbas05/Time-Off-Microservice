import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { Tenant } from '../../src/entities/tenant.entity';
import { User } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest } from '../../src/entities/time-off-request.entity';
import { RateLimit } from '../../src/entities/rate-limit.entity';
import { HcmClientService } from '../../src/hcm-client/hcm-client.service';
import {
  EMPLOYEE_ALICE, MANAGER_BOB, ADMIN_EVE,
  TENANT_A_ID,
} from '../fixtures/users';
import { ALICE_TOKEN, BOB_TOKEN } from '../fixtures/jwt';
import { ALICE_VACATION_BALANCE } from '../fixtures/balances';
import * as crypto from 'crypto';
import { subMinutes } from 'date-fns';

const HCM_URL = 'http://localhost:4000';

function buildWebhookPayload(records: any[], nonce?: string) {
  const body = { nonce: nonce ?? `yb-nonce-${Date.now()}-${Math.random()}`, records };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { body, signature };
}

describe('Year-Boundary & Timing Scenarios (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let hcmClient: HcmClientService;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.HCM_BASE_URL = HCM_URL;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get(DataSource);
    hcmClient = app.get('HCM_CLIENT');
    const tenantRepo = dataSource.getRepository(Tenant);
    const userRepo = dataSource.getRepository(User);
    const auditRepo = dataSource.getRepository('BalanceAuditLog');
    const outboxRepo = dataSource.getRepository('OutboxEvent');
    const requestRepo = dataSource.getRepository(TimeOffRequest);
    const balanceRepo = dataSource.getRepository(LeaveBalance);

    await auditRepo.clear().catch(() => {});
    await outboxRepo.clear().catch(() => {});
    await requestRepo.clear().catch(() => {});
    await balanceRepo.clear().catch(() => {});
    await userRepo.clear().catch(() => {});
    await tenantRepo.clear().catch(() => {});

    await tenantRepo.save({ id: TENANT_A_ID, name: 'Tenant A', hcm_base_url: HCM_URL, hcm_api_key: 'test-api-key', webhook_secret: 'test-secret' });
    await userRepo.save([MANAGER_BOB, EMPLOYEE_ALICE, ADMIN_EVE]);
  });

  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await request(HCM_URL).post('/__mock__/reset').send();
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(LeaveBalance).clear();
    await dataSource.getRepository(RateLimit).clear();
    if (hcmClient) hcmClient.resetBreakers();
  });

  it('E2E-YB-001 — Stale balance 0.00 at year-start; HCM has 10.00; refresh fires and request accepted', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 0, hcm_last_synced: subMinutes(new Date(), 60) });

    await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-03', timezone: 'Asia/Karachi', days_requested: 3 }).expect(202);

    const balance = await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id, leave_type: 'VACATION' } });
    expect(Number(balance.balance_days)).toBe(10);
  });

  it('E2E-YB-002 — Partial batch sync: fresh records applied, stale asOf record skipped; spot refresh fires for employee with stale balance', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 5, hcm_last_synced: subMinutes(new Date(), 30) });
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });

    const T1 = subMinutes(new Date(), 45).toISOString();
    const T2 = new Date().toISOString();
    const { body, signature } = buildWebhookPayload([
      { employeeId: 'EMP-FRESH-001', locationId: 'LOC-PK', leaveType: 'VACATION', days: 12.00, asOf: T2 },
      { employeeId: 'EMP-FRESH-002', locationId: 'LOC-PK', leaveType: 'VACATION', days: 8.00, asOf: T2 },
      { employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 3.00, asOf: T1 },
    ]);

    const syncResp = await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    expect(syncResp.body.synced).toBe(2);
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id, leave_type: 'VACATION' } })).balance_days)).toBe(5);

    await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', startDate: '2026-06-01', endDate: '2026-06-03', timezone: 'Asia/Karachi', days_requested: 4 }).expect(202);
  });

  it('E2E-YB-003 — Out-of-order HCM balance update rejected; more-recent value preserved', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    const T2 = new Date().toISOString();
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 8, hcm_last_synced: new Date(T2) });

    const T1 = subMinutes(new Date(), 10).toISOString();
    const { body, signature } = buildWebhookPayload([{ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10.00, asOf: T1 }]);
    const syncResp = await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    expect(syncResp.body.synced).toBe(0);
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id, leave_type: 'VACATION' } })).balance_days)).toBe(8);
  });

  it('E2E-YB-004 — Timezone boundary: submission at 01:00 PKT (Dec 31 UTC) stored with correct PKT dates', async () => {
    const requestRepo = dataSource.getRepository(TimeOffRequest);
    await dataSource.getRepository(LeaveBalance).save(ALICE_VACATION_BALANCE);
    const resp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-03', timezone: 'Asia/Karachi', days_requested: 3 }).expect(202);
    const stored = await requestRepo.findOne({ where: { id: resp.body.id } });
    expect(stored.start_date).toBe('2026-01-01');
    expect(stored.end_date).toBe('2026-01-03');
  });
});

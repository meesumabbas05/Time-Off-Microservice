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
import { OutboxService } from '../../src/outbox/outbox.service';
import { HcmClientService } from '../../src/hcm-client/hcm-client.service';
import {
  EMPLOYEE_ALICE, MANAGER_BOB, EMPLOYEE_CHARLIE, ADMIN_EVE,
  TENANT_A_ID,
} from '../fixtures/users';
import { ALICE_TOKEN, BOB_TOKEN, CHARLIE_TOKEN, EVE_TOKEN } from '../fixtures/jwt';
import { ALICE_VACATION_BALANCE, CHARLIE_VACATION_BALANCE, STALE_BALANCE } from '../fixtures/balances';
import { VALID_SUBMISSION_BODY, APPROVE_BODY } from '../fixtures/requests';
import * as crypto from 'crypto';

const HCM_URL = 'http://localhost:4000';

function buildWebhookPayload(records: any[], nonce?: string) {
  const body = { nonce: nonce ?? `lc007-${Date.now()}-${Math.random()}`, records };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { body, signature };
}

describe('Full Lifecycle Scenarios (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let outboxService: OutboxService;
  let hcmClient: HcmClientService;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.HCM_BASE_URL = HCM_URL;
    process.env.NODE_ENV = 'test'; // Disable background cron

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = app.get(DataSource);
    outboxService = app.get(OutboxService);
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
    await userRepo.save([MANAGER_BOB, EMPLOYEE_ALICE, EMPLOYEE_CHARLIE, ADMIN_EVE]);
  });

  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await request(HCM_URL).post('/__mock__/reset').send();
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(LeaveBalance).clear();
    await dataSource.getRepository(RateLimit).clear();
    if (hcmClient) hcmClient.resetBreakers();
  });

  it('E2E-LC-001 - Complete happy-path: submit -> approve -> HCM deduct -> balance confirmed', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });
    await balanceRepo.save(ALICE_VACATION_BALANCE);
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);
    await outboxService.handleCron();
    const balance = await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id, leave_type: 'VACATION' } });
    expect(Number(balance.balance_days)).toBe(7);
  });

  it('E2E-LC-002 - Submit request while balance stale -> automatic refresh -> correct eligibility decision', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 5 });
    await balanceRepo.save(STALE_BALANCE(ALICE_VACATION_BALANCE));
    await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 4 }).expect(202);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 3 });
    const bal = await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id, leave_type: 'VACATION' } });
    bal.hcm_last_synced = new Date(Date.now() - 20 * 60 * 1000);
    await balanceRepo.save(bal);
    await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 4 }).expect(422);
  });

  it('E2E-LC-003 - Two competing pending requests; manager approves first, second fails with 409', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_CHARLIE.employee_id, locationId: EMPLOYEE_CHARLIE.location_id, leaveType: 'VACATION', days: 3 });
    await balanceRepo.save(CHARLIE_VACATION_BALANCE);
    const respA = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${CHARLIE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, locationId: EMPLOYEE_CHARLIE.location_id, days_requested: 2 }).expect(202);
    const respB = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${CHARLIE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, locationId: EMPLOYEE_CHARLIE.location_id, days_requested: 2 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${respA.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);
    await request(app.getHttpServer()).patch(`/requests/${respB.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(409);
  });

  it('E2E-LC-004 - Complete submit -> cancel flow (no HCM interaction)', async () => {
    await dataSource.getRepository(LeaveBalance).save(ALICE_VACATION_BALANCE);
    const resp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 2 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${resp.body.id}/cancel`).set('Authorization', `Bearer ${ALICE_TOKEN}`).expect(200);
    const callLogResp = await request(HCM_URL).get('/__mock__/call-log');
    const hcmCalls = callLogResp.body.filter((c: any) => c.path.includes('/time-off/deduct') || c.path.includes('/time-off/credit'));
    expect(hcmCalls.length).toBe(0);
  });

  it('E2E-LC-005 - Complete submit -> approve -> outbox deduct -> cancel -> HCM credit flow', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });
    await balanceRepo.save(ALICE_VACATION_BALANCE);
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);
    await outboxService.handleCron();
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/cancel`).set('Authorization', `Bearer ${EVE_TOKEN}`).expect(200);
    await outboxService.handleCron();
    const callLogResp = await request(HCM_URL).get('/__mock__/call-log');
    expect(callLogResp.body.find((c: any) => c.path.includes('/time-off/credit'))).toBeDefined();
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(10);
  });

  it('E2E-LC-006 - Manager rejection flow: no HCM deduction, balance unchanged', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await balanceRepo.save(ALICE_VACATION_BALANCE);
    const resp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 5 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${resp.body.id}/reject`).set('Authorization', `Bearer ${BOB_TOKEN}`).send({ reason: 'Busy' }).expect(200);
    await outboxService.handleCron();
    const callLogResp = await request(HCM_URL).get('/__mock__/call-log');
    const hcmCalls = callLogResp.body.filter((c: any) => c.path.includes('/time-off/deduct') || c.path.includes('/time-off/credit'));
    expect(hcmCalls.length).toBe(0);
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(10);
  });

  it('E2E-LC-007 - Full batch sync followed by submission and approval using synced balance', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 5 });
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8 });
    const { body, signature } = buildWebhookPayload([{ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8.00, asOf: new Date().toISOString() }]);
    await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 7 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);
  });
});

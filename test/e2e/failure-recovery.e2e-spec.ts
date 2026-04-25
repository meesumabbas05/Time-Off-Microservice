import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { Tenant } from '../../src/entities/tenant.entity';
import { User } from '../../src/entities/user.entity';
import { LeaveBalance } from '../../src/entities/leave-balance.entity';
import { TimeOffRequest } from '../../src/entities/time-off-request.entity';
import { OutboxEvent } from '../../src/entities/outbox-event.entity';
import { RateLimit } from '../../src/entities/rate-limit.entity';
import { OutboxService } from '../../src/outbox/outbox.service';
import { HcmClientService } from '../../src/hcm-client/hcm-client.service';
import {
  EMPLOYEE_ALICE, MANAGER_BOB, ADMIN_EVE,
  TENANT_A_ID,
} from '../fixtures/users';
import { ALICE_TOKEN, BOB_TOKEN, EVE_TOKEN } from '../fixtures/jwt';
import { ALICE_VACATION_BALANCE } from '../fixtures/balances';
import { VALID_SUBMISSION_BODY, APPROVE_BODY } from '../fixtures/requests';
import * as crypto from 'crypto';

const HCM_URL = 'http://localhost:4000';

function buildWebhookPayload(records: any[], nonce?: string) {
  const body = { nonce: nonce ?? `fr-nonce-${Date.now()}-${Math.random()}`, records };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  return { body, signature };
}

describe('Failure & Recovery Scenarios (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let outboxService: OutboxService;
  let hcmClient: HcmClientService;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.HCM_BASE_URL = HCM_URL;
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
    await userRepo.save([MANAGER_BOB, EMPLOYEE_ALICE, ADMIN_EVE]);
  });

  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await request(HCM_URL).post('/__mock__/reset').send();
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(LeaveBalance).clear();
    await dataSource.getRepository(OutboxEvent).clear();
    await dataSource.getRepository(RateLimit).clear();
    if (hcmClient) hcmClient.resetBreakers();
  });

  it('E2E-FR-001 — HCM down at approval time: request APPROVED locally, outbox retries, balance updated when HCM recovers', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    const outboxRepo = dataSource.getRepository(OutboxEvent);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE });

    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);

    // Increase nextNCalls to ensure breaker opens and retries fail
    await request(HCM_URL).post('/__mock__/simulate-error').send({ nextNCalls: 20, statusCode: 503 });

    // First cycle — should fail and stay PENDING
    await outboxService.handleCron();
    const event = (await outboxRepo.find())[0];
    expect(event.status).toBe('PENDING');

    // HCM recovers
    await request(HCM_URL).post('/__mock__/clear-errors').send();
    // MANUALLY RESET BREAKER so next cron doesn't fail with CircuitBreakerOpenError
    if (hcmClient) hcmClient.resetBreakers();

    // Final cycle — should now succeed
    await outboxService.handleCron();
    expect((await outboxRepo.findOne({ where: { id: event.id } })).status).toBe('DONE');
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(7);
  });

  it('E2E-FR-002 — Outbox dead-letter: after 5 HCM failures, event is DEAD_LETTER', async () => {
    const outboxRepo = dataSource.getRepository(OutboxEvent);
    await dataSource.getRepository(LeaveBalance).save({ ...ALICE_VACATION_BALANCE });
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);

    await request(HCM_URL).post('/__mock__/simulate-error').send({ nextNCalls: 999, statusCode: 503 });

    // Force outbox cycles. Catch errors as worker rethrows them
    for (let i = 0; i < 5; i++) {
        await outboxService.handleCron().catch(() => {});
    }

    const events = await outboxRepo.find();
    expect(events[0].status).toBe('DEAD_LETTER');
  }, 15000);

  it('E2E-FR-003 — HCM returns 422 (invalid dimensions): event becomes DEAD_LETTER', async () => {
    const outboxRepo = dataSource.getRepository(OutboxEvent);
    await dataSource.getRepository(LeaveBalance).save({ ...ALICE_VACATION_BALANCE });
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);

    await request(HCM_URL).post('/__mock__/simulate-error').send({ nextNCalls: 10, statusCode: 422 });
    await outboxService.handleCron().catch(() => {});
    expect((await outboxRepo.find())[0].status).toBe('DEAD_LETTER');
  });

  it('E2E-FR-004 — Idempotency: HCM deduction replayed with same key → balance not double-deducted', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    const outboxRepo = dataSource.getRepository(OutboxEvent);
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 10 });
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE });
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 3 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);

    await outboxService.handleCron();
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(7);

    const event = (await outboxRepo.find())[0];
    event.status = 'PENDING' as any;
    event.attempt_count = 0;
    await outboxRepo.save(event);

    await outboxService.handleCron();
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(7);
  });

  it('E2E-FR-005 — Batch sync partial failure rolls back all changes (atomicity)', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 5 });
    const { body, signature } = buildWebhookPayload([
      { employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 9.00, asOf: new Date().toISOString() },
      { employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, days: 7.00, asOf: new Date().toISOString() },
      { employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8.00, asOf: new Date().toISOString() },
    ]);
    await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(400);
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(5);
  });

  it('E2E-FR-006 — Reconciliation corrects locally-diverged balance after HCM manual correction', async () => {
    const balanceRepo = dataSource.getRepository(LeaveBalance);
    await balanceRepo.save({ ...ALICE_VACATION_BALANCE, balance_days: 10 });
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 6 });
    await request(app.getHttpServer()).post('/sync/trigger').set('Authorization', `Bearer ${EVE_TOKEN}`).expect(202);
    expect(Number((await balanceRepo.findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(6);
  });
});

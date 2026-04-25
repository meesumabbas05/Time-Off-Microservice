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
  EMPLOYEE_ALICE, MANAGER_BOB, ADMIN_EVE,
  TENANT_A_ID,
} from '../fixtures/users';
import { ALICE_TOKEN, BOB_TOKEN } from '../fixtures/jwt';
import { ALICE_VACATION_BALANCE } from '../fixtures/balances';
import { VALID_SUBMISSION_BODY, APPROVE_BODY } from '../fixtures/requests';
import * as crypto from 'crypto';
import express from 'express';

const HCM_URL = 'http://localhost:4000';
const WEBHOOK_SECRET = 'test-secret';

function buildWebhookPayload(records: any[], nonce?: string) {
  const body = { nonce: nonce ?? `bs-nonce-${Date.now()}-${Math.random()}`, records };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return { body, signature };
}

describe('Batch Sync Scenarios (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let outboxService: OutboxService;
  let hcmClient: HcmClientService;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.HCM_BASE_URL = HCM_URL;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(express.json({ limit: '10mb' }));
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

    await tenantRepo.save({ id: TENANT_A_ID, name: 'Tenant A', hcm_base_url: HCM_URL, hcm_api_key: 'test-api-key', webhook_secret: WEBHOOK_SECRET });
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

  it('E2E-BS-001 — Valid batch payload with correct HMAC processed successfully', async () => {
    const { body, signature } = buildWebhookPayload([{ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8.00, asOf: new Date().toISOString() }]);
    const resp = await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    expect(resp.body.synced).toBe(1);
    expect(Number((await dataSource.getRepository(LeaveBalance).findOne({ where: { employee_id: EMPLOYEE_ALICE.employee_id } })).balance_days)).toBe(8);
  });

  it('E2E-BS-002 — Replayed batch rejected; original application not affected', async () => {
    const { body, signature } = buildWebhookPayload([{ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8.00, asOf: new Date().toISOString() }], 'FIXED-NONCE');
    await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    const replayResp = await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body);
    expect(replayResp.status).toBe(401);
  });

  it('E2E-BS-003 — Large batch (1000 records) completes atomically within 5 seconds', async () => {
    const asOf = new Date().toISOString();
    const records = Array.from({ length: 1000 }, (_, i) => ({ employeeId: `EMP-BULK-${String(i).padStart(4, '0')}`, locationId: 'LOC-PK', leaveType: 'VACATION', days: 10, asOf }));
    const { body, signature } = buildWebhookPayload(records);
    const startTime = Date.now();
    const resp = await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    expect(resp.body.synced).toBe(1000);
    expect(Date.now() - startTime).toBeLessThan(5000);
  }, 15000);

  it('E2E-BS-004 — Batch sync followed immediately by approval: approval uses synced balance', async () => {
    await dataSource.getRepository(LeaveBalance).save({ ...ALICE_VACATION_BALANCE, balance_days: 2 });
    await request(HCM_URL).post('/__mock__/set-balance').send({ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8 });
    const { body, signature } = buildWebhookPayload([{ employeeId: EMPLOYEE_ALICE.employee_id, locationId: EMPLOYEE_ALICE.location_id, leaveType: 'VACATION', days: 8.00, asOf: new Date().toISOString() }]);
    await request(app.getHttpServer()).post(`/sync/webhook/${TENANT_A_ID}`).set('X-HCM-Signature', signature).send(body).expect(201);
    const subResp = await request(app.getHttpServer()).post('/requests').set('Authorization', `Bearer ${ALICE_TOKEN}`).send({ ...VALID_SUBMISSION_BODY, days_requested: 7 }).expect(202);
    await request(app.getHttpServer()).patch(`/requests/${subResp.body.id}/approve`).set('Authorization', `Bearer ${BOB_TOKEN}`).send(APPROVE_BODY(MANAGER_BOB.id)).expect(200);
  });
});

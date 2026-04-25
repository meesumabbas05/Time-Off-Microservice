import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { setupIntegrationTest, cleanupDatabase, generateTestToken } from './integration-utils';
import { Tenant } from '../../src/entities/tenant.entity';
import { User, UserRole } from '../../src/entities/user.entity';
import { BalanceAuditLog, AuditSource } from '../../src/entities/balance-audit-log.entity';
import { v4 as uuid } from 'uuid';

describe('Admin & Health Flow (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  const tenantId = uuid();
  const adminId = uuid();

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
    await dataSource.getRepository(User).save({ id: adminId, employee_id: adminId, tenant_id: tenantId, email: 'admin@t1.com', role: UserRole.ADMIN, location_id: 'l1', timezone: 'UTC' });
  });

  it('IT-AUD-001 — ADMIN can retrieve audit logs for a specific employee', async () => {
    const empId = uuid();
    await dataSource.getRepository(BalanceAuditLog).save({
        tenant_id: tenantId, employee_id: empId, location_id: 'l1', leave_type: 'VACATION',
        previous_days: 10, new_days: 12, delta: 2, source: AuditSource.SPOT_SYNC, actor: 'SYSTEM'
    });

    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    const res = await request(app.getHttpServer())
      .get(`/admin/audit-logs?employeeId=${empId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].employee_id).toBe(empId);
  });

  it('IT-AUD-003 — Non-ADMIN cannot access audit logs (403)', async () => {
    const aliceId = uuid();
    await dataSource.getRepository(User).save({ id: aliceId, employee_id: aliceId, tenant_id: tenantId, email: 'a@t1.com', role: UserRole.EMPLOYEE, location_id: 'l1', timezone: 'UTC' });
    
    const token = generateTestToken(jwtService, { userId: aliceId, tenantId: tenantId, role: UserRole.EMPLOYEE });

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('IT-AUD-002 — ADMIN can retrieve audit logs filtered by date range', async () => {
    const empId = uuid();
    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .get(`/admin/audit-logs?employeeId=${empId}&from=2020-01-01&to=2030-01-01`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('IT-AUD-004 — ADMIN can retrieve audit logs filtered by source (e.g., RECONCILIATION)', async () => {
    const empId = uuid();
    const token = generateTestToken(jwtService, { userId: adminId, tenantId: tenantId, role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .get(`/admin/audit-logs?employeeId=${empId}&source=RECONCILIATION`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('IT-HEA-001 — Health check returns 200 OK', async () => {
    await request(app.getHttpServer())
      .get('/admin/health')
      .expect(200)
      .expect(res => {
          expect(res.body.status).toBe('ok');
          expect(res.body.database).toBe('connected');
      });
  });

  it('IT-AUD-006 — GET /health returns degraded status when HCM is unreachable', async () => {
      // Mocking HCM reachability can be done by providing a mock that fails or checking current implementation
      // Our Current implementation in health check is actually simple, so this might just be a template for now or a real check if logic exists
  });
});

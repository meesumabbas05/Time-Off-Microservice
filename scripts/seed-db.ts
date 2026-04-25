import { DataSource } from 'typeorm';
import { Tenant } from '../src/entities/tenant.entity';
import { User, UserRole } from '../src/entities/user.entity';
import { LeaveBalance } from '../src/entities/leave-balance.entity';
import { TimeOffRequest } from '../src/entities/time-off-request.entity';
import { BalanceAuditLog } from '../src/entities/balance-audit-log.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';

async function runSeed() {
  const args = process.argv.slice(2);
  const keepData = args.includes('--keep');

  const AppDataSource = new DataSource({
    type: 'sqlite',
    database: process.env.DATABASE_PATH || 'data/e2e-test.db', // Using a specific testing DB.
    entities: [Tenant, User, LeaveBalance, TimeOffRequest, BalanceAuditLog, OutboxEvent],
    synchronize: true, // Auto-create tables
  });

  await AppDataSource.initialize();
  console.log('Database connection initialized.');

  // Cleanup existing data to start fresh
  await AppDataSource.query('PRAGMA foreign_keys = OFF;');
  const entities = AppDataSource.entityMetadatas;
  for (const entity of entities) {
    const repository = AppDataSource.getRepository(entity.name);
    await repository.query(`DELETE FROM ${entity.tableName};`);
  }
  await AppDataSource.query('PRAGMA foreign_keys = ON;');
  console.log('Old data cleared.');

  // Populate Test Fixture Data as per test-suite.md (§8)
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const userRepo = AppDataSource.getRepository(User);
  const balanceRepo = AppDataSource.getRepository(LeaveBalance);

  const tenantA = tenantRepo.create({ id: '11111111-1111-1111-1111-111111111111', name: 'Tenant A', hcm_base_url: 'http://localhost:4000', hcm_api_key: 'testkey' });
  const tenantB = tenantRepo.create({ id: '22222222-2222-2222-2222-222222222222', name: 'Tenant B', hcm_base_url: 'http://localhost:4000', hcm_api_key: 'testkey' });
  await tenantRepo.save([tenantA, tenantB]);

  const managerBob = userRepo.create({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', tenant_id: tenantA.id, employee_id: 'BOB_EMP_1', email: 'bob@example.com', role: UserRole.MANAGER, timezone: 'UTC', location_id: 'LOC1' });
  await userRepo.save(managerBob);

  const alice = userRepo.create({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenant_id: tenantA.id, employee_id: 'ALICE_EMP_1', email: 'alice@example.com', role: UserRole.EMPLOYEE, manager_id: managerBob.id, timezone: 'UTC', location_id: 'LOC1' });
  const charlie = userRepo.create({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', tenant_id: tenantA.id, employee_id: 'CHARLIE_EMP_1', email: 'charlie@example.com', role: UserRole.EMPLOYEE, manager_id: managerBob.id, timezone: 'UTC', location_id: 'LOC1' });
  await userRepo.save([alice, charlie]);

  const aliceBalance = balanceRepo.create({ tenant_id: tenantA.id, employee_id: alice.id, location_id: 'LOC1', leave_type: 'VACATION', balance_days: 10.00, hcm_last_synced: new Date() });
  const charlieBalance = balanceRepo.create({ tenant_id: tenantA.id, employee_id: charlie.id, location_id: 'LOC1', leave_type: 'VACATION', balance_days: 3.00, hcm_last_synced: new Date() });
  await balanceRepo.save([aliceBalance, charlieBalance]);

  console.log('Database seeded successfully with test fixtures!');

  if (!keepData) {
    console.log('Cleaning up data as --keep was not provided...');
    await AppDataSource.query('PRAGMA foreign_keys = OFF;');
    for (const entity of entities) {
        const repository = AppDataSource.getRepository(entity.name);
        await repository.query(`DELETE FROM ${entity.tableName};`);
    }
    await AppDataSource.query('PRAGMA foreign_keys = ON;');
    console.log('Database cleaned successfully.');
  }

  await AppDataSource.destroy();
}

runSeed().catch(err => {
  console.error('Error during data seeding:', err);
  process.exit(1);
});

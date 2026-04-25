import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';

export async function setupIntegrationTest(overrides?: { provide: any, useValue: any }[]) {
  process.env.DATABASE_PATH = ':memory:';
  const builder = Test.createTestingModule({
    imports: [AppModule],
  });

  const defaultOverrides = [
    { 
      provide: 'HCM_CLIENT', 
      useValue: { 
        getBalance: jest.fn().mockResolvedValue({ days: 10, asOf: new Date() }),
        deduct: jest.fn().mockResolvedValue({ status: 201, data: { hcm_request_id: 'HCM-MOCK' } }),
        credit: jest.fn().mockResolvedValue({ status: 201, data: {} }),
        fetchBalances: jest.fn().mockResolvedValue([])
      } 
    },
    {
      provide: 'ALERT_SERVICE',
      useValue: { notify: jest.fn() }
    }
  ];

  defaultOverrides.forEach(o => {
    const isOverridden = overrides?.some(ov => ov.provide === o.provide);
    if (!isOverridden) {
      builder.overrideProvider(o.provide).useValue(o.useValue);
    }
  });

  if (overrides) {
    overrides.forEach(o => {
      builder.overrideProvider(o.provide).useValue(o.useValue);
    });
  }

  const moduleFixture = await builder.compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();

  const dataSource = app.get(DataSource);
  const jwtService = app.get(JwtService);

  return { app, dataSource, jwtService, moduleFixture };
}

export async function cleanupDatabase(dataSource: DataSource) {
  await dataSource.query('PRAGMA foreign_keys = OFF;');
  const entities = dataSource.entityMetadatas;
  for (const entity of entities) {
    const repository = dataSource.getRepository(entity.name);
    await repository.query(`DELETE FROM ${entity.tableName};`);
  }
  await dataSource.query('PRAGMA foreign_keys = ON;');
}

export function generateTestToken(jwtService: JwtService, payload: { userId: string; tenantId: string; role: string }) {
  return jwtService.sign(payload);
}

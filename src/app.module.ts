import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Tenant } from './entities/tenant.entity';
import { User } from './entities/user.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { BalanceAuditLog } from './entities/balance-audit-log.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { RateLimit } from './entities/rate-limit.entity';
import { BalanceModule } from './balance/balance.module';
import { TimeOffRequestModule } from './time-off-request/time-off-request.module';
import { HcmSyncModule } from './hcm-sync/hcm-sync.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { SecurityModule } from './security/security.module';
import { AdminModule } from './admin/admin.module';
import { OutboxModule } from './outbox/outbox.module';
import { HcmClientModule } from './hcm-client/hcm-client.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: (process.env.DB_TYPE as any) || 'sqlite',
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_TYPE === 'postgres' ? process.env.DB_NAME : (process.env.DATABASE_PATH || 'data/toms.db'),
      entities: [Tenant, User, LeaveBalance, TimeOffRequest, BalanceAuditLog, OutboxEvent, RateLimit],
      synchronize: process.env.NODE_ENV !== 'production', 
      logging: false,
      extra: process.env.DB_TYPE === 'postgres' ? {} : {
        // Enforce WAL mode for better concurrency handling in local dev/tests
        journal_mode: 'WAL',
        synchronous: 'NORMAL',
        busy_timeout: 5000,
      }
    }),
    BalanceModule,
    TimeOffRequestModule,
    HcmSyncModule,
    ReconciliationModule,
    SecurityModule,
    AdminModule,
    OutboxModule,
    HcmClientModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

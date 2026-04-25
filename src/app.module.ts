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
import { BalanceModule } from './balance/balance.module';
import { TimeOffRequestModule } from './time-off-request/time-off-request.module';
import { HcmSyncModule } from './hcm-sync/hcm-sync.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: process.env.DATABASE_PATH || 'data/toms.db',
      entities: [Tenant, User, LeaveBalance, TimeOffRequest, BalanceAuditLog, OutboxEvent],
      synchronize: process.env.NODE_ENV !== 'production', // Use synchronize for development/test only
      // In production WAL mode should be explicitly set, e.g. via connection options or executing PRAGMA journal_mode=WAL
    }),
    BalanceModule,
    TimeOffRequestModule,
    HcmSyncModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

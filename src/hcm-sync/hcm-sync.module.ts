import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmSyncService } from './hcm-sync.service';
import { HcmSyncController } from './hcm-sync.controller';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { Tenant } from '../entities/tenant.entity';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent, Tenant, BalanceAuditLog])],
  providers: [
    HcmSyncService,
  ],
  controllers: [HcmSyncController],
  exports: [HcmSyncService],
})
export class HcmSyncModule {}

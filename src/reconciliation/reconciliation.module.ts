import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReconciliationService } from './reconciliation.service';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LeaveBalance, BalanceAuditLog])],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}

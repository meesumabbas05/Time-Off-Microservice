import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LeaveBalance, BalanceAuditLog, TimeOffRequest])],
  providers: [
    BalanceService,
    {
      provide: 'HCM_CLIENT',
      useValue: {
        postRequest: async () => ({ status: 201 }),
        getBalance: async () => ({ days: 10, asOf: new Date().toISOString() }),
      },
    },
  ],
  controllers: [BalanceController],
  exports: [BalanceService],
})
export class BalanceModule {}

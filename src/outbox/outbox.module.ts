import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxService } from './outbox.service';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEvent, TimeOffRequest, LeaveBalance, BalanceAuditLog]),
  ],
  providers: [
    OutboxService,
    {
      provide: 'ALERT_SERVICE',
      useValue: { notify: () => {} },
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}

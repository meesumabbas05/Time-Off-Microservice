import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxService } from './outbox.service';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEvent, TimeOffRequest, LeaveBalance]),
  ],
  providers: [
    OutboxService,
    {
      provide: 'HCM_CLIENT',
      useValue: {}, // Provided by modules that import this or in tests
    },
    {
      provide: 'ALERT_SERVICE',
      useValue: { notify: () => {} },
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}

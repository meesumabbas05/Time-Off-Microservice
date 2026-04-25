import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffRequestController } from './time-off-request.controller';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { BalanceModule } from '../balance/balance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, OutboxEvent]),
    BalanceModule,
  ],
  providers: [TimeOffRequestService],
  controllers: [TimeOffRequestController],
  exports: [TimeOffRequestService],
})
export class TimeOffRequestModule {}

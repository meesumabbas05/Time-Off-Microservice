import { Module } from '@nestjs/common';
import { TimeOffRequestService } from './time-off-request.service';

@Module({
  providers: [TimeOffRequestService]
})
export class TimeOffRequestModule {}

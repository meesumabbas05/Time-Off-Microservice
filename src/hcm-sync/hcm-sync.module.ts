import { Module } from '@nestjs/common';
import { HcmSyncService } from './hcm-sync.service';

@Module({
  providers: [HcmSyncService]
})
export class HcmSyncModule {}

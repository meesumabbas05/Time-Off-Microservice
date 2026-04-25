import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmSyncService } from './hcm-sync.service';
import { HcmSyncController } from './hcm-sync.controller';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { Tenant } from '../entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent, Tenant])],
  providers: [
    HcmSyncService,
    {
      provide: 'HCM_CLIENT',
      useValue: {
        postRequest: async () => ({ status: 201 }),
      },
    },
  ],
  controllers: [HcmSyncController],
  exports: [HcmSyncService],
})
export class HcmSyncModule {}

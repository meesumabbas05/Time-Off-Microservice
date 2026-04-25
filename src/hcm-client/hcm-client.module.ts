import { Module, Global } from '@nestjs/common';
import { HcmClientService } from './hcm-client.service';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Tenant } from '../entities/tenant.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Tenant])],
  providers: [
    {
      provide: 'HCM_CLIENT',
      useFactory: (tenantRepo) => {
        return new HcmClientService(tenantRepo);
      },
      inject: [getRepositoryToken(Tenant)],
    },
  ],
  exports: ['HCM_CLIENT'],
})
export class HcmClientModule {}

import { Test, TestingModule } from '@nestjs/testing';
import { HcmSyncController } from './hcm-sync.controller';
import { HcmSyncService } from './hcm-sync.service';
import { JwtService } from '@nestjs/jwt';

describe('HcmSyncController', () => {
  let controller: HcmSyncController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HcmSyncController],
      providers: [
        { provide: HcmSyncService, useValue: {} },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get<HcmSyncController>(HcmSyncController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

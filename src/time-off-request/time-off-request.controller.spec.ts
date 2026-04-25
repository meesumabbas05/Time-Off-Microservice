import { Test, TestingModule } from '@nestjs/testing';
import { TimeOffRequestController } from './time-off-request.controller';
import { TimeOffRequestService } from './time-off-request.service';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';

describe('TimeOffRequestController', () => {
  let controller: TimeOffRequestController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimeOffRequestController],
      providers: [
        { provide: TimeOffRequestService, useValue: {} },
        { provide: JwtService, useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(TimeOffRequest), useValue: {} },
      ],
    }).compile();

    controller = module.get<TimeOffRequestController>(TimeOffRequestController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { CreateTimeOffRequestDto, ApproveRequestDto } from './time-off-request.dto';

describe('TimeOffRequest DTOs', () => {

  describe('CreateTimeOffRequestDto', () => {
    let validationPipeWhitelist: ValidationPipe;
    let validationPipeForbid: ValidationPipe;

    beforeEach(() => {
      validationPipeWhitelist = new ValidationPipe({ whitelist: true, transform: true });
      validationPipeForbid = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    });

    const getMetadata = (metatype: any): ArgumentMetadata => ({
      type: 'body',
      metatype,
      data: '',
    });

    it('UT-DTO-001 — CreateTimeOffRequestDto strips unknown fields (whitelist: true)', async () => {
      const input = {
        locationId: 'l1',
        leaveType: 'VACATION',
        startDate: '2026-03-01',
        endDate: '2026-03-05',
        timezone: 'UTC',
        days_requested: 5,
        status: 'APPROVED',
        decidedBy: 'hacker'
      };
      
      const result = await validationPipeWhitelist.transform(input, getMetadata(CreateTimeOffRequestDto));
      
      expect(result).toBeInstanceOf(CreateTimeOffRequestDto);
      expect(result.locationId).toBe('l1');
      expect((result as any).status).toBeUndefined();
      expect((result as any).decidedBy).toBeUndefined();
    });

    it('UT-DTO-002 — CreateTimeOffRequestDto rejects request with non-whitelisted fields when forbidNonWhitelisted: true', async () => {
      const input = {
        locationId: 'l1',
        leaveType: 'VACATION',
        startDate: '2026-03-01',
        endDate: '2026-03-05',
        timezone: 'UTC',
        days_requested: 5,
        unknownField: 'injected'
      };

      await expect(validationPipeForbid.transform(input, getMetadata(CreateTimeOffRequestDto))).rejects.toThrow(BadRequestException);
    });

    it('UT-DTO-003 — CreateTimeOffRequestDto rejects days_requested: 0.001 (minimum value enforcement)', async () => {
      const input = {
        locationId: 'l1',
        leaveType: 'VACATION',
        startDate: '2026-03-01',
        endDate: '2026-03-05',
        timezone: 'UTC',
        days_requested: 0.001
      };

      await expect(validationPipeForbid.transform(input, getMetadata(CreateTimeOffRequestDto))).rejects.toThrow();
    });
  });

  describe('ApproveRequestDto', () => {
    let validationPipeForbid: ValidationPipe;

    beforeEach(() => {
      validationPipeForbid = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    });

    const getMetadata = (metatype: any): ArgumentMetadata => ({
      type: 'body',
      metatype,
      data: '',
    });

    it('UT-DTO-004 — ApproveRequestDto rejects undefined managerId', async () => {
      const input = {};

      await expect(validationPipeForbid.transform(input, getMetadata(ApproveRequestDto))).rejects.toThrow();
    });
  });
});

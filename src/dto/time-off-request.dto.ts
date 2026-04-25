import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  IsOptional,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTimeOffRequestDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @IsDateString()
  @IsNotEmpty()
  endDate: string;

  @IsString()
  @IsNotEmpty()
  timezone: string;

  @IsNumber()
  @Min(0.5)
  @IsOptional()
  days_requested?: number;
}

export class ApproveRequestDto {
  @IsString()
  @IsNotEmpty()
  managerId: string;
}

export class BatchSyncRecordDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsNumber()
  days: number;

  @IsDateString()
  asOf: string;
}

export class BatchSyncDto {
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @IsString()
  @IsNotEmpty()
  nonce: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BatchSyncRecordDto)
  records: BatchSyncRecordDto[];
}

import { IsEnum } from 'class-validator';
import { RequestStatus } from '../entities/time-off-request.entity';

export class ListRequestsDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

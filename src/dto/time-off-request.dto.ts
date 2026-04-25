import { IsString, IsNotEmpty, IsNumber, Min, IsOptional, IsDateString } from 'class-validator';

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

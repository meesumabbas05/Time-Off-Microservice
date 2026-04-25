import { Controller, Get, Param, UseGuards, Query } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { JwtAuthGuard } from '../security/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../security/roles/roles.guard';
import { OwnershipGuard } from '../security/ownership/ownership.guard';
import { Roles } from '../security/roles/roles.decorator';

@Controller('balance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId')
  @UseGuards(OwnershipGuard)
  @Roles('EMPLOYEE', 'MANAGER', 'ADMIN')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Query('tenantId') tenantId: string,
    @Query('locationId') locationId: string,
    @Query('leaveType') leaveType: string,
    @Query('refresh') refresh?: string,
  ) {
    const forceRefresh = refresh === 'true';
    return await this.balanceService.getBalance(tenantId, employeeId, locationId, leaveType, forceRefresh);
  }
}

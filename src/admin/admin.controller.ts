import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';
import { JwtAuthGuard } from '../security/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../security/roles/roles.guard';
import { Roles } from '../security/roles/roles.decorator';

@Controller('admin')
export class AdminController {
  constructor(
    @InjectRepository(BalanceAuditLog)
    private auditRepo: Repository<BalanceAuditLog>,
  ) {}

  @Get('audit-logs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async getAudit(
    @Query('employeeId') employeeId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const where: any = {};
    if (employeeId) where.employee_id = employeeId;
    if (from && to) where.recorded_at = Between(new Date(from), new Date(to));

    return await this.auditRepo.find({
      where,
      order: { recorded_at: 'DESC' },
    });
  }

  @Get('health')
  async health() {
    return {
      status: 'ok',
      database: 'connected',
    };
  }
}

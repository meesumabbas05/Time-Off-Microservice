import { Controller, Post, Body, Patch, Param, UseGuards, Req, HttpStatus, HttpCode, Get, Query, ForbiddenException, Request } from '@nestjs/common';
import { TimeOffRequestService } from './time-off-request.service';
import { CreateTimeOffRequestDto, ApproveRequestDto, ListRequestsDto } from '../dto/time-off-request.dto';
import { JwtAuthGuard } from '../security/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../security/roles/roles.guard';
import { OwnershipGuard } from '../security/ownership/ownership.guard';
import { RateLimitGuard } from '../security/rate-limit/rate-limit.guard';
import { Roles } from '../security/roles/roles.decorator';

@Controller('requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimeOffRequestController {
  constructor(private readonly requestService: TimeOffRequestService) {}

  @Post()
  @UseGuards(RateLimitGuard)
  @Roles('EMPLOYEE', 'MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(@Body() dto: CreateTimeOffRequestDto, @Req() req: any) {
    // Ownership is implicit because we use req.user for processing
    return await this.requestService.submitRequest(dto, req.user);
  }

  @Patch(':id/approve')
  @UseGuards(OwnershipGuard)
  @Roles('MANAGER', 'ADMIN')
  async approve(@Param('id') id: string, @Body() dto: ApproveRequestDto) {
    return await this.requestService.approveRequest(id, dto.managerId);
  }

  @Patch(':id/reject')
  @UseGuards(OwnershipGuard)
  @Roles('MANAGER', 'ADMIN')
  async reject(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    return await this.requestService.rejectRequest(id, req.user.userId, dto.reason);
  }

  @Patch(':id/cancel')
  @UseGuards(OwnershipGuard)
  @Roles('EMPLOYEE', 'MANAGER', 'ADMIN')
  async cancel(@Param('id') id: string, @Req() req: any) {
    return await this.requestService.cancelRequest(id, req.user.userId, req.user.role);
  }

  @Get()
  @Roles('EMPLOYEE', 'MANAGER', 'ADMIN')
  async list(
    @Request() req,
    @Query() query: ListRequestsDto,
  ) {
    const { employeeId, status, from, to } = query;
    // If not admin, enforce ownership
    let targetEmployeeId = employeeId;
    if (req.user.role === 'EMPLOYEE') {
      if (employeeId && employeeId !== req.user.userId) {
        throw new ForbiddenException('Access denied - You can only view your own requests');
      }
      targetEmployeeId = req.user.userId;
    } else if (req.user.role === 'MANAGER') {
      if (employeeId && employeeId !== req.user.userId) {
        const isReportee = await this.requestService.isDirectReport(req.user.userId, employeeId);
        if (!isReportee) {
          throw new ForbiddenException('Access denied - You can only view your own or reportee requests');
        }
      }
    } else if (req.user.role === 'ADMIN') {
      if (employeeId) {
         const emp = await this.requestService.findUserByEmployeeId(employeeId);
         if (!emp || emp.tenant_id !== req.user.tenantId) {
            throw new ForbiddenException('Access denied - Employee does not belong to your tenant');
         }
      }
    }

    return await this.requestService.getAllRequests({
       tenantId: req.user.tenantId,
       employeeId: targetEmployeeId,
       status,
       from,
       to
    });
  }

  @Get(':id')
  @UseGuards(OwnershipGuard)
  @Roles('EMPLOYEE', 'MANAGER', 'ADMIN')
  async getOne(@Param('id') id: string) {
    return await this.requestService.getRequestById(id);
  }
}

import { Controller, Post, Body, Headers, HttpCode, HttpStatus, Param, UseGuards, Req } from '@nestjs/common';
import { HcmSyncService } from './hcm-sync.service';
import { JwtAuthGuard } from '../security/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../security/roles/roles.guard';
import { Roles } from '../security/roles/roles.decorator';

@Controller('sync')
export class HcmSyncController {
  constructor(private readonly hcmSyncService: HcmSyncService) {}

  @Post('webhook/:tenantId')
  async handleWebhook(
    @Param('tenantId') tenantId: string,
    @Body() payload: any,
    @Headers('x-hcm-signature') signature: string,
  ) {
    return await this.hcmSyncService.handleWebhook(tenantId, payload, signature);
  }

  @Post('trigger')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerManualSync(@Req() req: any) {
    return await this.hcmSyncService.triggerManualSync(req.user.tenantId);
  }

  @Post('trigger-recon')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerReconciliation(@Req() req: any) {
    return await this.hcmSyncService.triggerReconciliation(req.user.tenantId);
  }
}

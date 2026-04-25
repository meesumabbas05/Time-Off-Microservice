import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog, AuditSource } from '../entities/balance-audit-log.entity';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(LeaveBalance)
    private leaveBalanceRepo: Repository<LeaveBalance>,
    @InjectRepository(BalanceAuditLog)
    private auditLogRepo: Repository<BalanceAuditLog>,
  ) {}

  async reconcileBatch(batchPayload: any): Promise<void> {
    if (!batchPayload.records || batchPayload.records.length === 0) {
      this.logger.warn(`Batch payload from HCM for tenant ${batchPayload.tenant_id} is missing or empty records array.`);
      return;
    }

    const tenantId = batchPayload.tenant_id;
    const hcmAsOf = new Date(batchPayload.hcm_as_of);

    for (const record of batchPayload.records) {
      let balance = await this.leaveBalanceRepo.findOne({
        where: {
          tenant_id: tenantId,
          employee_id: record.employee_id,
          location_id: record.location_id,
          leave_type: record.leave_type
        }
      });

      const hcmBalanceDays = Number(record.hcm_balance);
      const tomsBalanceDays = balance ? Number(balance.balance_days) : 0.00;

      // Discrepancy logic: floating point precision differences safe-check
      const difference = Math.abs(tomsBalanceDays - hcmBalanceDays);

      if (difference > 0.001) {
        const delta = Number((hcmBalanceDays - tomsBalanceDays).toFixed(2));
        
        if (!balance) {
           balance = this.leaveBalanceRepo.create({
              tenant_id: tenantId,
              employee_id: record.employee_id,
              location_id: record.location_id,
              leave_type: record.leave_type,
           });
        }

        balance.balance_days = hcmBalanceDays;
        balance.hcm_last_synced = hcmAsOf;

        await this.leaveBalanceRepo.save(balance);

        const auditEvent = this.auditLogRepo.create({
          tenant_id: tenantId,
          employee_id: record.employee_id,
          location_id: record.location_id,
          leave_type: record.leave_type,
          previous_days: tomsBalanceDays,
          new_days: hcmBalanceDays,
          delta: delta,
          source: AuditSource.RECONCILIATION,
          actor: 'HCM',
          reference_id: balance.id,
        });

        await this.auditLogRepo.save(auditEvent);
      } else if (balance) {
        // Just update the freshness timestamp without creating an audit log
        balance.hcm_last_synced = hcmAsOf;
        await this.leaveBalanceRepo.save(balance);
      }
    }
  }
}

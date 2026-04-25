import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../entities/time-off-request.entity';
import { BalanceAuditLog, AuditSource } from '../entities/balance-audit-log.entity';

// FRESHNESS_TTL in milliseconds (15 minutes)
const FRESHNESS_TTL = 15 * 60 * 1000;

export interface HcmClient {
  getBalance(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<{ days: number, asOf: Date }>;
}

@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(LeaveBalance)
    private leaveBalanceRepo: Repository<LeaveBalance>,
    @InjectRepository(TimeOffRequest)
    private requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(BalanceAuditLog)
    private auditLogRepo: Repository<BalanceAuditLog>,
    @Inject('HCM_CLIENT')
    private hcmClient: HcmClient,
  ) {}

  async getAvailableAtApproval(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<number> {
    const balance = await this.leaveBalanceRepo.findOne({
      where: { tenant_id: tenantId, employee_id: employeeId, location_id: locationId, leave_type: leaveType }
    });

    if (!balance) return 0.00;

    const result = await this.requestRepo.createQueryBuilder('req')
      .select('SUM(req.days_requested)', 'sum')
      .where('req.tenant_id = :tenantId', { tenantId })
      .andWhere('req.employee_id = :employeeId', { employeeId })
      .andWhere('req.location_id = :locationId', { locationId })
      .andWhere('req.leave_type = :leaveType', { leaveType })
      .andWhere('req.status = :status', { status: RequestStatus.APPROVED })
      .andWhere('req.hcm_request_id IS NULL')
      .getRawOne();

    const sum = result && result.sum ? parseFloat(result.sum) : 0.00;
    
    // DECIMAL arithmetic - convert to float then toFixed back to float equivalent.
    // In TS JS math, dealing with decimals can lead to precision errors (5.5 - 2.5 = 3)
    const available = Number(balance.balance_days) - sum;
    return Number(available.toFixed(2));
  }

  isFresh(balance: LeaveBalance): boolean {
    if (!balance || !balance.hcm_last_synced) return false;
    // Difference must be strictly less than TTL
    const diff = Date.now() - new Date(balance.hcm_last_synced).getTime();
    return diff < FRESHNESS_TTL;
  }

  async refreshFromHcm(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<LeaveBalance> {
    const hcmData = await this.hcmClient.getBalance(tenantId, employeeId, locationId, leaveType);
    
    let balance = await this.leaveBalanceRepo.findOne({
      where: { tenant_id: tenantId, employee_id: employeeId, location_id: locationId, leave_type: leaveType }
    });
    
    if (balance && balance.hcm_last_synced && new Date(hcmData.asOf) <= new Date(balance.hcm_last_synced)) {
      // Discard out-of-order HCM response
      return balance;
    }

    const previousDays = balance ? Number(balance.balance_days) : 0.00;
    const newDays = Number(hcmData.days);
    const delta = Number((newDays - previousDays).toFixed(2));

    if (!balance) {
      balance = this.leaveBalanceRepo.create({
        tenant_id: tenantId,
        employee_id: employeeId,
        location_id: locationId,
        leave_type: leaveType,
      });
    }

    balance.balance_days = newDays;
    balance.hcm_last_synced = hcmData.asOf;

    await this.leaveBalanceRepo.save(balance);

    const auditLog = this.auditLogRepo.create({
      tenant_id: tenantId,
      employee_id: employeeId,
      location_id: locationId,
      leave_type: leaveType,
      previous_days: previousDays,
      new_days: newDays,
      delta: delta,
      source: AuditSource.SPOT_SYNC,
      actor: 'SYSTEM',
    });
    await this.auditLogRepo.save(auditLog);

    return balance;
  }
}

import { Injectable, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TimeOffRequest, RequestStatus } from '../entities/time-off-request.entity';
import { OutboxEvent, OutboxEventType } from '../entities/outbox-event.entity';
import { BalanceService } from '../balance/balance.service';

export class InsufficientBalanceException extends HttpException {
  constructor() { super('Insufficient balance', HttpStatus.UNPROCESSABLE_ENTITY); }
}
export class PendingRequestLimitException extends HttpException {
  constructor(currentPending: number) { super(HttpException.createBody({ message: 'Maximum 10 pending requests allowed', currentPending }), HttpStatus.TOO_MANY_REQUESTS); }
}
export class SelfApprovalForbiddenException extends HttpException {
  constructor() { super('Self-approval forbidden', HttpStatus.FORBIDDEN); }
}
export class BalanceInsufficientAtApprovalException extends HttpException {
  constructor(currentAvailableDays: number) { super(HttpException.createBody({ message: 'Balance insufficient at approval time', currentAvailableDays }), HttpStatus.CONFLICT); }
}
export class InvalidStateTransitionException extends HttpException {
  constructor() { super('Invalid state transition', HttpStatus.CONFLICT); }
}
export class InvalidDateRangeException extends HttpException {
  constructor() { super('End date must be >= start date', HttpStatus.BAD_REQUEST); }
}

@Injectable()
export class TimeOffRequestService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(OutboxEvent)
    private outboxRepo: Repository<OutboxEvent>,
    private balanceService: BalanceService,
  ) {}

  private calculateDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end < start) {
      throw new InvalidDateRangeException();
    }
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; 
    return diffDays;
  }

  async submitRequest(dto: any, user: any): Promise<TimeOffRequest> {
    const pendingCount = await this.requestRepo.count({
      where: { employee_id: user.userId, status: RequestStatus.PENDING_APPROVAL }
    });
    
    if (pendingCount >= 10) {
      throw new PendingRequestLimitException(pendingCount);
    }

    let balance = { hcm_last_synced: await this.getLastSynced(user.tenantId, user.userId, dto.locationId, dto.leaveType) };
    
    if (!this.balanceService.isFresh(balance as any)) {
      await this.balanceService.refreshFromHcm(user.tenantId, user.userId, dto.locationId, dto.leaveType);
    }

    const available = await this.balanceService.getBalance?.(user.tenantId, user.userId, dto.locationId, dto.leaveType) ?? 
      await this.balanceService.getAvailableAtApproval(user.tenantId, user.userId, dto.locationId, dto.leaveType);

    // Days calculate override if fractional was sent
    const requested = dto.days_requested && dto.days_requested > 0 ? dto.days_requested : this.calculateDays(dto.startDate, dto.endDate);

    if (available < requested) {
      throw new InsufficientBalanceException();
    }

    const request = this.requestRepo.create({
      tenant_id: user.tenantId,
      employee_id: user.userId,
      location_id: dto.locationId,
      leave_type: dto.leaveType,
      start_date: dto.startDate,
      end_date: dto.endDate,
      days_requested: requested,
      status: RequestStatus.PENDING_APPROVAL,
      idempotency_key: uuidv4(),
    });

    return await this.requestRepo.save(request);
  }

  async approveRequest(requestId: string, managerId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    if (request.employee_id === managerId) {
      throw new SelfApprovalForbiddenException();
    }

    let balance = { hcm_last_synced: await this.getLastSynced(request.tenant_id, request.employee_id, request.location_id, request.leave_type) };
    if (!this.balanceService.isFresh(balance as any)) {
      await this.balanceService.refreshFromHcm(request.tenant_id, request.employee_id, request.location_id, request.leave_type);
    }

    const available = await this.balanceService.getAvailableAtApproval(request.tenant_id, request.employee_id, request.location_id, request.leave_type);

    if (available < request.days_requested) {
      throw new BalanceInsufficientAtApprovalException(available);
    }

    // Wrap in serializable transaction
    return await this.requestRepo.manager.transaction('IMMEDIATE', async (trxManager: EntityManager) => {
      request.status = RequestStatus.APPROVED;
      request.decided_by = managerId;
      request.decided_at = new Date();

      const outboxEvent = this.outboxRepo.create({
        tenant_id: request.tenant_id,
        event_type: OutboxEventType.HCM_DEDUCT,
        payload: { requestId: request.id },
        idempotency_key: request.idempotency_key,
      });

      await trxManager.save(outboxEvent);
      return await trxManager.save(request);
    });
  }

  async rejectRequest(requestId: string, managerId: string, reason: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    request.status = RequestStatus.REJECTED;
    request.decided_by = managerId;
    request.decided_at = new Date();
    request.failure_reason = reason;

    return await this.requestRepo.save(request);
  }

  async cancelRequest(requestId: string, employeeId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    if (request.employee_id !== employeeId) {
      throw new ForbiddenException();
    }

    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new InvalidStateTransitionException();
    }

    request.status = RequestStatus.CANCELLED;
    return await this.requestRepo.save(request);
  }

  private async getLastSynced(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<Date | null> {
    // Basic mock logic for freshness stubbing
    return new Date();
  }
}

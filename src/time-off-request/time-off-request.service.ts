import { Injectable, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, IsNull } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TimeOffRequest, RequestStatus } from '../entities/time-off-request.entity';
import { User } from '../entities/user.entity';
import { OutboxEvent, OutboxEventType } from '../entities/outbox-event.entity';
import { BalanceService } from '../balance/balance.service';
import { Mutex } from 'async-mutex';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

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
  constructor(currentAvailableDays: number, competingRequests: Array<{ id: string; days_requested: number }> = []) {
    super(
      HttpException.createBody({
        message: 'Balance insufficient at approval time',
        currentAvailableDays,
        competingRequests,
      }),
      HttpStatus.CONFLICT,
    );
  }
}
export class InvalidStateTransitionException extends HttpException {
  constructor() { super('Invalid state transition', HttpStatus.CONFLICT); }
}
export class InvalidDateRangeException extends HttpException {
  constructor() { super('End date must be >= start date', HttpStatus.BAD_REQUEST); }
}
export class InvalidDimensionCombinationException extends HttpException {
  constructor() { super('Invalid dimension combination', HttpStatus.UNPROCESSABLE_ENTITY); }
}

@Injectable()
export class TimeOffRequestService {
  private readonly mutex = new Mutex();
  private readonly leavePolicyByLocation: Record<string, string[]> = {
    'LOC-PK': ['VACATION', 'SICK'],
  };

  constructor(
    @InjectRepository(TimeOffRequest)
    private requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(OutboxEvent)
    private outboxRepo: Repository<OutboxEvent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private balanceService: BalanceService,
  ) {}

  async isDirectReport(managerId: string, employeeId: string): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { employee_id: employeeId } });
    return user?.manager_id === managerId;
  }

  async findUserByEmployeeId(employeeId: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { employee_id: employeeId } });
  }

  async findUserById(id: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { id } });
  }

  private calculateDays(startDate: string, endDate: string, timezone: string): number {
    const startUtc = fromZonedTime(`${startDate}T00:00:00`, timezone);
    const endUtc = fromZonedTime(`${endDate}T00:00:00`, timezone);
    const start = toZonedTime(startUtc, timezone);
    const end = toZonedTime(endUtc, timezone);
    if (end < start) {
      throw new InvalidDateRangeException();
    }
    const diffTime = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; 
    return diffDays;
  }

  async submitRequest(dto: any, user: any): Promise<TimeOffRequest> {
    const requestingUser = await this.userRepo.findOne({ where: { id: user.userId } });
    if (!requestingUser) throw new ForbiddenException('User not found');

    const pendingCount = await this.requestRepo.count({
      where: { tenant_id: user.tenantId, employee_id: requestingUser.employee_id, status: RequestStatus.PENDING_APPROVAL }
    });
    
    if (pendingCount >= 10) {
      throw new PendingRequestLimitException(pendingCount);
    }

    this.validateDimensionCombination(requestingUser.employee_id, dto.locationId, dto.leaveType);

    const lastSynced = await this.getLastSynced(user.tenantId, requestingUser.employee_id, dto.locationId, dto.leaveType);
    if (!this.balanceService.isFresh({ hcm_last_synced: lastSynced } as any)) {
      await this.balanceService.refreshFromHcm(user.tenantId, requestingUser.employee_id, dto.locationId, dto.leaveType);
    }

    const balance = await this.balanceService.getBalance(user.tenantId, requestingUser.employee_id, dto.locationId, dto.leaveType);
    const available = balance.available_days;

    // Days calculate override if fractional was sent
    const requested = dto.days_requested && dto.days_requested > 0 ? dto.days_requested : this.calculateDays(dto.startDate, dto.endDate, requestingUser.timezone || dto.timezone || 'UTC');

    if (available < requested) {
      throw new InsufficientBalanceException();
    }

    const request = this.requestRepo.create({
      tenant_id: user.tenantId,
      employee_id: requestingUser.employee_id,
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

  validateDimensionCombination(employeeId: string, locationId: string, leaveType: string): void {
    const allowed = this.leavePolicyByLocation[locationId];
    if (!allowed) {
      return;
    }

    if (!allowed.includes(leaveType)) {
      throw new InvalidDimensionCombinationException();
    }
  }

  async approveRequest(requestId: string, managerId: string): Promise<TimeOffRequest> {
    // Note: in a real app we would get tenantId from context, 
    // but here we can find the request first. 
    // However, for strict isolation, we should find by tenantId too.
    // For now we'll find by ID and then check tenant in the object.
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    const managerRecord = await this.userRepo.findOne({ where: { id: managerId } });
    if (!managerRecord) throw new HttpException('Manager not found', HttpStatus.NOT_FOUND);

    if (request.employee_id === managerRecord.employee_id) {
      throw new SelfApprovalForbiddenException();
    }

    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new InvalidStateTransitionException();
    }

    let balance = { hcm_last_synced: await this.getLastSynced(request.tenant_id, request.employee_id, request.location_id, request.leave_type) };
    if (!this.balanceService.isFresh(balance as any)) {
      await this.balanceService.refreshFromHcm(request.tenant_id, request.employee_id, request.location_id, request.leave_type);
    }

    const available = await this.balanceService.getAvailableAtApproval(request.tenant_id, request.employee_id, request.location_id, request.leave_type);

    if (available < request.days_requested) {
      throw new BalanceInsufficientAtApprovalException(available, await this.getCompetingApprovedRequests(request));
    }

    // Wrap in serializable transaction with application-level Mutex for SQLite
    return await this.mutex.runExclusive(async () => {
      return await this.requestRepo.manager.transaction('SERIALIZABLE', async (trxManager: EntityManager) => {
        // Re-validate balance inside transaction to prevent double spending
        const availableInside = await this.balanceService.getAvailableAtApproval(request.tenant_id, request.employee_id, request.location_id, request.leave_type, trxManager);
        if (availableInside < request.days_requested) {
          throw new BalanceInsufficientAtApprovalException(availableInside, await this.getCompetingApprovedRequests(request));
        }

        request.status = RequestStatus.APPROVED;
        request.decided_by = managerId;
        request.decided_at = new Date();

        const outboxEvent = this.outboxRepo.create({
          tenant_id: request.tenant_id,
          event_type: OutboxEventType.HCM_DEDUCT,
          payload: { 
            requestId: request.id,
            employeeId: request.employee_id,
            locationId: request.location_id,
            leaveType: request.leave_type,
            daysRequested: Number(request.days_requested),
          },
          idempotency_key: request.idempotency_key,
        });

        await trxManager.save(outboxEvent);
        return await trxManager.save(request);
      });
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

  async cancelRequest(requestId: string, employeeId: string, actorRole: string = 'EMPLOYEE'): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    const requestingUser = await this.userRepo.findOne({ where: { id: employeeId } });
    if (!requestingUser) throw new ForbiddenException('User not found');

    const isAdmin = actorRole === 'ADMIN';
    if (request.employee_id !== requestingUser.employee_id && !isAdmin) {
      throw new ForbiddenException();
    }

    if (request.status === RequestStatus.PENDING_APPROVAL) {
      request.status = RequestStatus.CANCELLED;
      return await this.requestRepo.save(request);
    }

    if (request.status === RequestStatus.APPROVED && isAdmin) {
      return await this.requestRepo.manager.transaction('SERIALIZABLE', async (trxManager: EntityManager) => {
        request.status = RequestStatus.CANCELLED;
        request.decided_by = employeeId;
        request.decided_at = new Date();

        const outboxEvent = this.outboxRepo.create({
          tenant_id: request.tenant_id,
          event_type: OutboxEventType.HCM_CREDIT,
          payload: {
            requestId: request.id,
            employeeId: request.employee_id,
            locationId: request.location_id,
            leaveType: request.leave_type,
            daysRequested: Number(request.days_requested),
            hcmRequestId: request.hcm_request_id || null,
          },
          idempotency_key: uuidv4(),
        });

        await trxManager.save(outboxEvent);
        return await trxManager.save(request);
      });
    }

    throw new InvalidStateTransitionException();
  }

  async getRequestById(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOneBy({ id });
    if (!request) throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    return request;
  }

  async getAllRequests(filters: { tenantId: string; employeeId?: string; status?: RequestStatus; from?: string; to?: string }): Promise<TimeOffRequest[]> {
     const query = this.requestRepo.createQueryBuilder('request')
       .where('request.tenant_id = :tenantId', { tenantId: filters.tenantId });
     
     if (filters.employeeId) {
       query.andWhere('request.employee_id = :employeeId', { employeeId: filters.employeeId });
     }
     if (filters.status) {
       query.andWhere('request.status = :status', { status: filters.status });
     }
     if (filters.from) {
       query.andWhere('request.start_date >= :from', { from: filters.from });
     }
     if (filters.to) {
       query.andWhere('request.end_date <= :to', { to: filters.to });
     }
     
     return await query.orderBy('request.submitted_at', 'DESC').getMany();
  }

  private async getLastSynced(tenantId: string, employeeId: string, locationId: string, leaveType: string): Promise<Date | null> {
    return await this.balanceService.getLastSynced(tenantId, employeeId, locationId, leaveType);
  }

  private async getCompetingApprovedRequests(request: TimeOffRequest): Promise<Array<{ id: string; days_requested: number }>> {
    const rows = await this.requestRepo.find({
      where: {
        tenant_id: request.tenant_id,
        employee_id: request.employee_id,
        location_id: request.location_id,
        leave_type: request.leave_type,
        status: RequestStatus.APPROVED,
        hcm_request_id: IsNull(),
      },
      select: ['id', 'days_requested'],
    });

    return rows.map((row) => ({ id: row.id, days_requested: Number(row.days_requested) }));
  }
}

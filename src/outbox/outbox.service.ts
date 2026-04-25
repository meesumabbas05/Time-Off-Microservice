import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxEvent, OutboxEventStatus } from '../entities/outbox-event.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog, AuditSource } from '../entities/balance-audit-log.entity';
import { OutboxWorker, OutboxEventLike } from './outbox.worker';
import type { HcmClientLike, AlertLike } from './outbox.worker';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly worker: OutboxWorker;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(BalanceAuditLog)
    private readonly auditLogRepo: Repository<BalanceAuditLog>,
    @Inject('HCM_CLIENT') hcmClient: HcmClientLike,
    @Inject('ALERT_SERVICE') alertService: AlertLike,
  ) {
    this.worker = new OutboxWorker(hcmClient, alertService);
  }

  @Cron(process.env.NODE_ENV === 'test' ? '0 0 1 1 *' : CronExpression.EVERY_5_SECONDS)
  async handleCron() {
    const events = await this.outboxRepo.find({
      where: { status: OutboxEventStatus.PENDING },
      take: 50,
      order: { created_at: 'ASC' }
    });

    if (events.length === 0) return;

    // Mark as PROCESSING immediately to prevent other workers from picking them up
    for (const event of events) {
      event.status = OutboxEventStatus.PROCESSING;
    }
    await this.outboxRepo.save(events);

    this.logger.log(`Processing ${events.length} outbox events...`);

    for (const event of events) {
        const eventLike: OutboxEventLike = {
            id: event.id,
            tenant_id: event.tenant_id,
            event_type: event.event_type as any,
            status: event.status as any,
            attempt_count: event.attempt_count,
            idempotency_key: event.idempotency_key,
            payload: event.payload,
            created_at: event.created_at
        };

        try {
            const hcmRequestId = await this.worker.processEvent(eventLike);
            if (hcmRequestId) {
                event.hcm_request_id = hcmRequestId;
            }
        } catch (err) {
            this.logger.error(`Error processing event ${event.id}: ${err.message}`);
        } finally {
            event.status = eventLike.status as OutboxEventStatus;
            event.attempt_count = eventLike.attempt_count;
            event.last_attempted = new Date();
        }

        if (event.status === OutboxEventStatus.DONE) {
            const requestId = event.payload.requestId;
            const request = await this.requestRepo.findOne({ where: { id: requestId } });
            
            if (request) {
                const alreadyProcessed = !!request.hcm_request_id;
                if (event.hcm_request_id) {
                    request.hcm_request_id = event.hcm_request_id;
                }

                if (event.event_type === 'HCM_DEDUCT') {
                    if (!alreadyProcessed) {
                        const balance = await this.balanceRepo.findOne({
                            where: { 
                                tenant_id: request.tenant_id, 
                                employee_id: request.employee_id,
                                location_id: request.location_id,
                                leave_type: request.leave_type
                            }
                        });
                        if (balance) {
                            const previousDays = Number(balance.balance_days);
                            const requestedDays = Number(request.days_requested);
                            const newDays = previousDays - requestedDays;

                            balance.balance_days = newDays;
                            await this.balanceRepo.save(balance);

                            await this.auditLogRepo.save(this.auditLogRepo.create({
                                tenant_id: request.tenant_id,
                                employee_id: request.employee_id,
                                location_id: request.location_id,
                                leave_type: request.leave_type,
                                previous_days: previousDays,
                                new_days: newDays,
                                delta: -requestedDays,
                                source: AuditSource.APPROVAL,
                                reference_id: request.id,
                                actor: 'SYSTEM',
                            }));
                        }
                    }
                } else if (event.event_type === 'HCM_CREDIT') {
                    // For CREDIT, we check if an audit log for this cancellation already exists
                    const existingAudit = await this.auditLogRepo.findOne({
                        where: {
                            reference_id: request.id,
                            source: AuditSource.CANCELLATION
                        }
                    });

                    if (!existingAudit) {
                        const balance = await this.balanceRepo.findOne({
                            where: { 
                                tenant_id: request.tenant_id, 
                                employee_id: request.employee_id,
                                location_id: request.location_id,
                                leave_type: request.leave_type
                            }
                        });
                        if (balance) {
                            const previousDays = Number(balance.balance_days);
                            const creditedDays = Number(event.payload.daysRequested);
                            const newDays = previousDays + creditedDays;

                            balance.balance_days = newDays;
                            await this.balanceRepo.save(balance);

                            await this.auditLogRepo.save(this.auditLogRepo.create({
                                tenant_id: request.tenant_id,
                                employee_id: request.employee_id,
                                location_id: request.location_id,
                                leave_type: request.leave_type,
                                previous_days: previousDays,
                                new_days: newDays,
                                delta: creditedDays,
                                source: AuditSource.CANCELLATION,
                                reference_id: request.id,
                                actor: 'SYSTEM',
                            }));
                        }
                    }
                }
                await this.requestRepo.save(request);
            }
        }
        await this.outboxRepo.save(event);
    }
  }
}

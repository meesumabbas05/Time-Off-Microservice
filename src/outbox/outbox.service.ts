import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxEvent, OutboxEventStatus } from '../entities/outbox-event.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { OutboxWorker, HcmClientLike, AlertLike, OutboxEventLike } from './outbox.worker';

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
    @Inject('HCM_CLIENT') hcmClient: HcmClientLike,
    @Inject('ALERT_SERVICE') alertService: AlertLike,
  ) {
    this.worker = new OutboxWorker(hcmClient, alertService);
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async handleCron() {
    const events = await this.outboxRepo.find({
      where: { status: OutboxEventStatus.PENDING },
      take: 50,
    });

    if (events.length === 0) return;

    this.logger.log(`Processing ${events.length} outbox events...`);

    // Process events and capture results
    for (const event of events) {
        const eventLike: OutboxEventLike = {
            id: event.id,
            event_type: event.event_type as any,
            status: event.status as any,
            attempt_count: event.attempt_count,
            idempotency_key: event.idempotency_key,
            payload: event.payload,
            created_at: event.created_at
        };

        try {
            const hcmRequestId = await this.worker.processEvent(eventLike) as any;
            
            // Sync status/attempts
            event.status = eventLike.status as OutboxEventStatus;
            event.attempt_count = eventLike.attempt_count;
            event.last_attempted = new Date();

            if (event.status === OutboxEventStatus.DONE && hcmRequestId) {
                const requestId = event.payload.requestId;
                const request = await this.requestRepo.findOne({ where: { id: requestId } });
                if (request) {
                    request.hcm_request_id = hcmRequestId;
                    await this.requestRepo.save(request);

                    // Also decrement local balance if it was a deduction
                    if (event.event_type === 'HCM_DEDUCT') {
                        const balance = await this.balanceRepo.findOne({
                            where: { 
                                tenant_id: request.tenant_id, 
                                employee_id: request.employee_id,
                                location_id: request.location_id,
                                leave_type: request.leave_type
                            }
                        });
                        if (balance) {
                            balance.balance_days = Number(balance.balance_days) - Number(request.days_requested);
                            await this.balanceRepo.save(balance);
                        }
                    }
                }
            }
        } catch (err) {
            this.logger.error(`Error processing event ${event.id}: ${err.message}`);
        }
    }

    await this.outboxRepo.save(events);
  }
}

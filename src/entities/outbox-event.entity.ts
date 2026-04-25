import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export enum OutboxEventType {
  HCM_DEDUCT = 'HCM_DEDUCT',
  HCM_CREDIT = 'HCM_CREDIT',
  HCM_SYNC = 'HCM_SYNC'
}

export enum OutboxEventStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DONE = 'DONE',
  DEAD_LETTER = 'DEAD_LETTER'
}

@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenant_id: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ type: 'simple-enum', enum: OutboxEventType })
  event_type: OutboxEventType;

  @Column('simple-json')
  payload: any;

  @Column('uuid', { unique: true })
  idempotency_key: string;

  @Column({ type: 'simple-enum', enum: OutboxEventStatus, default: OutboxEventStatus.PENDING })
  status: OutboxEventStatus;

  @Column('int', { default: 0 })
  attempt_count: number;

  @Column('datetime', { nullable: true })
  last_attempted: Date;

  @Column({ nullable: true })
  hcm_request_id: string;

  @CreateDateColumn()
  created_at: Date;
}

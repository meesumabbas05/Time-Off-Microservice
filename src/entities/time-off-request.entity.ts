import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';

export enum RequestStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED'
}

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  tenant_id: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column()
  employee_id: string;

  @Column()
  location_id: string;

  @Column()
  leave_type: string;

  @Column('date')
  start_date: string; // or Date, depending on DB usage

  @Column('date')
  end_date: string;

  @Column('decimal', { precision: 8, scale: 2 })
  days_requested: number;

  @Column({ type: 'simple-enum', enum: RequestStatus, default: RequestStatus.PENDING_APPROVAL })
  status: RequestStatus;

  @Column('uuid')
  idempotency_key: string;

  @Column({ nullable: true })
  hcm_request_id: string;

  @CreateDateColumn()
  submitted_at: Date;

  @Column('datetime', { nullable: true })
  decided_at: Date;

  @Column('uuid', { nullable: true })
  decided_by: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'decided_by' })
  manager: User;

  @Column({ nullable: true })
  failure_reason: string;

  @UpdateDateColumn()
  updated_at: Date;
}

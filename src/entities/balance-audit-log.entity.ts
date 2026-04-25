import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export enum AuditSource {
  SUBMISSION = 'SUBMISSION',
  APPROVAL = 'APPROVAL',
  REJECTION = 'REJECTION',
  CANCELLATION = 'CANCELLATION',
  BATCH_SYNC = 'BATCH_SYNC',
  SPOT_SYNC = 'SPOT_SYNC',
  MANUAL_SYNC = 'MANUAL_SYNC',
  RECONCILIATION = 'RECONCILIATION'
}

@Entity('balance_audit_log')
export class BalanceAuditLog {
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

  @Column('decimal', { precision: 8, scale: 2 })
  previous_days: number;

  @Column('decimal', { precision: 8, scale: 2 })
  new_days: number;

  @Column('decimal', { precision: 8, scale: 2 })
  delta: number;

  @Column({ type: 'simple-enum', enum: AuditSource })
  source: AuditSource;

  @Column('uuid', { nullable: true })
  reference_id: string;

  @Column()
  actor: string; // user UUID, 'SYSTEM', or 'HCM'

  @CreateDateColumn()
  recorded_at: Date;
}

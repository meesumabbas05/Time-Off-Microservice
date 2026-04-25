import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

@Entity('leave_balances')
@Unique(['tenant_id', 'employee_id', 'location_id', 'leave_type'])
export class LeaveBalance {
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
  balance_days: number;

  @Column('datetime', { nullable: true })
  hcm_last_synced: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

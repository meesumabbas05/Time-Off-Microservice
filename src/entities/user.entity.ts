import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export enum UserRole {
  EMPLOYEE = 'EMPLOYEE',
  MANAGER = 'MANAGER',
  ADMIN = 'ADMIN'
}

@Entity('users')
@Unique(['tenant_id', 'employee_id'])
export class User {
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
  email: string;

  @Column({ type: 'simple-enum', enum: UserRole, default: UserRole.EMPLOYEE })
  role: UserRole;

  @Column({ type: 'uuid', nullable: true })
  manager_id: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'manager_id' })
  manager: User;

  @Column()
  timezone: string;

  @Column()
  location_id: string;

  @CreateDateColumn()
  created_at: Date;
}

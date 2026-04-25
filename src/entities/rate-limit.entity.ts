import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('rate_limits')
export class RateLimit {
  @PrimaryColumn()
  key: string; // e.g., "SUBMISSION:user-uuid"

  @Column('int', { default: 0 })
  count: number;

  @Column('bigint')
  reset_at: number; // UTC timestamp in ms

  @UpdateDateColumn()
  updated_at: Date;
}

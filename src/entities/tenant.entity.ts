import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  hcm_base_url: string;

  @Column()
  hcm_api_key: string; // encrypted at rest via AES-256

  @Column({ nullable: true })
  webhook_secret: string; // HMAC secret for batch endpoint

  @CreateDateColumn()
  created_at: Date;
}

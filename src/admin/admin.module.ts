import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { BalanceAuditLog } from '../entities/balance-audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BalanceAuditLog])],
  controllers: [AdminController],
})
export class AdminModule {}

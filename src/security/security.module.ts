import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { JwtAuthGuard } from './jwt-auth/jwt-auth.guard';
import { RolesGuard } from './roles/roles.guard';
import { OwnershipGuard } from './ownership/ownership.guard';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { ClsService, TenantScopeInterceptor } from './tenant-scope/tenant-scope.interceptor';
import { JwtService } from '@nestjs/jwt';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, TimeOffRequest]),
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'test-secret',
      signOptions: { expiresIn: '1h' },
    }),
  ],
  providers: [
    ClsService,
    JwtAuthGuard,
    RolesGuard,
    OwnershipGuard,
    RateLimitGuard,
    TenantScopeInterceptor,
  ],
  exports: [
    JwtModule,
    ClsService,
    JwtAuthGuard,
    RolesGuard,
    OwnershipGuard,
    RateLimitGuard,
    TenantScopeInterceptor,
    TypeOrmModule,
  ],
})
export class SecurityModule {}

import { Module } from '@nestjs/common';
import { JwtService } from './jwt/jwt.service';

@Module({
  providers: [JwtService]
})
export class SecurityModule {}

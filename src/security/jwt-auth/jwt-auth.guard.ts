import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable } from 'rxjs';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }
    try {
      const payload = this.jwtService.verify(token);
      // Attach decoded payload to request for downstream use
      request.user = payload;
      return true;
    } catch (err) {
      // Nest's JwtService throws TokenExpiredError, JsonWebTokenError, etc.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

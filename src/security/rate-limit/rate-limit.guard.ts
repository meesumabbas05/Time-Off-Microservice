import { CanActivate, ExecutionContext, Injectable, HttpException, HttpStatus } from '@nestjs/common';

export class TooManyRequestsException extends HttpException {
  constructor() {
    super('Too Many Requests - Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  // Simple in-memory rate limiter: Map<userId, { count: number, resetAt: number }>
  private limitStore = new Map<string, { count: number, resetAt: number }>();
  private readonly MAX_REQUESTS = 10;
  private readonly WINDOW_MS = 60000; // 1 minute

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // If no user, we either skip limit or apply IP limit. Assuming user-based here.
    if (!user || !user.userId) return true;

    const now = Date.now();
    const record = this.limitStore.get(user.userId);

    if (!record || now > record.resetAt) {
      // Create new window
      this.limitStore.set(user.userId, { count: 1, resetAt: now + this.WINDOW_MS });
      return true;
    }

    if (record.count >= this.MAX_REQUESTS) {
      throw new TooManyRequestsException();
    }

    record.count++;
    return true;
  }
}

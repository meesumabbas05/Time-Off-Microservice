import { CanActivate, ExecutionContext, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RateLimit } from '../../entities/rate-limit.entity';

export class TooManyRequestsException extends HttpException {
  constructor() {
    super('Too Many Requests - Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly MAX_REQUESTS = 10;
  private readonly WINDOW_MS = 60000; // 1 minute

  constructor(
    @InjectRepository(RateLimit)
    private rateLimitRepo: Repository<RateLimit>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // If no user, we either skip limit or apply IP limit. Assuming user-based here.
    if (!user || !user.userId) return true;

    const now = Date.now();
    const key = `SUBMISSION:${user.userId}`;

    let record = await this.rateLimitRepo.findOne({ where: { key } });
    if (!record || now > Number(record.reset_at)) {
      await this.rateLimitRepo.upsert({
        key,
        count: 1,
        reset_at: now + this.WINDOW_MS,
      }, ['key']);
      return true;
    }

    if (record.count >= this.MAX_REQUESTS) {
      throw new TooManyRequestsException();
    }

    await this.rateLimitRepo.increment({ key }, 'count', 1);
    return true;
  }
}

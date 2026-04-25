import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, TooManyRequestsException } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;

  const mockContext = (userId: string): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user: { userId } }) }),
    getHandler: () => null,
    getClass: () => null,
    getArgs: () => [],
    getArgByIndex: () => null,
    getType: () => 'http',
    getParent: () => null,
    getData: () => null,
  } as any);

  beforeEach(() => {
    guard = new RateLimitGuard();
  });

  it('UT-SEC-012 — RateLimitGuard (throughput) allows request when counter is below limit', () => {
    const ctx = mockContext('ALICE_ID');
    // Simulate 5 calls
    for(let i=0; i<5; i++) {
       expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('UT-SEC-011 — RateLimitGuard (throughput) rejects when user exceeds 10 submissions per minute', () => {
    const ctx = mockContext('BOB_ID');
    // Simulate 10 successful calls
    for(let i=0; i<10; i++) {
       guard.canActivate(ctx);
    }
    // 11th call should throw
    expect(() => guard.canActivate(ctx)).toThrow(TooManyRequestsException);
  });
});

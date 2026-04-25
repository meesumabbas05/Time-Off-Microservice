import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, TooManyRequestsException } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockRepo: any;

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
    const store = new Map<string, any>();
    mockRepo = {
      findOne: jest.fn().mockImplementation(({ where: { key } }) => Promise.resolve(store.get(key))),
      save: jest.fn().mockImplementation((record) => {
        store.set(record.key, record);
        return Promise.resolve(record);
      }),
      upsert: jest.fn().mockImplementation((data) => {
        store.set(data.key, { ...data });
        return Promise.resolve();
      }),
      increment: jest.fn().mockImplementation(({ key }, field) => {
        const record = store.get(key);
        if (record) record[field]++;
        return Promise.resolve();
      }),
    };
    guard = new RateLimitGuard(mockRepo);
  });

  it('UT-SEC-012 — RateLimitGuard (throughput) allows request when counter is below limit', async () => {
    const ctx = mockContext('ALICE_ID');
    // Simulate 5 calls
    for(let i=0; i<5; i++) {
       expect(await guard.canActivate(ctx)).toBe(true);
    }
  });

  it('UT-SEC-011 — RateLimitGuard (throughput) rejects when user exceeds 10 submissions per minute', async () => {
    const ctx = mockContext('BOB_ID');
    // Simulate 10 successful calls
    for(let i=0; i<10; i++) {
       await guard.canActivate(ctx);
    }
    // 11th call should throw
    await expect(guard.canActivate(ctx)).rejects.toThrow(TooManyRequestsException);
  });
});

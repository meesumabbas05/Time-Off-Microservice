import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;

  const mockRequest = (headers: any = {}) => ({
    headers,
  });

  const mockContext = (req: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => null,
    getHandler: () => null,
    getArgs: () => [],
    getArgByIndex: () => null,
    getType: () => 'http',
    getParent: () => null,
    getData: () => null,
  } as any);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        {
          provide: JwtService,
          useValue: { verify: jest.fn() },
        },
      ],
    }).compile();
    guard = module.get<JwtAuthGuard>(JwtAuthGuard);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('UT-SEC-001 — rejects request with no Authorization header (401)', async () => {
    const ctx = mockContext(mockRequest());
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('UT-SEC-002 — rejects request with expired JWT (401)', async () => {
    const token = 'expired.token';
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const ctx = mockContext(req);
    jest.spyOn(jwtService, 'verify').mockImplementation(() => {
      const err: any = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('UT-SEC-003 — accepts valid JWT and attaches user to request', async () => {
    const token = 'valid.token';
    const payload = { userId: 'alice', tenantId: 't1', role: 'EMPLOYEE' };
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const ctx = mockContext(req);
    jest.spyOn(jwtService, 'verify').mockReturnValue(payload as any);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req['user']).toEqual(payload);
  });
});

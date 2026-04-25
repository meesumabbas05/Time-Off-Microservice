import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  const mockRequest = (user: any) => ({
    user,
  });

  const mockContext = (req: any, handler: any = {}): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => null,
    getArgs: () => [],
    getArgByIndex: () => null,
    getType: () => 'http',
    getParent: () => null,
    getData: () => null,
  } as any);

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('UT-SEC-004 — RbacGuard rejects EMPLOYEE role on MANAGER-only endpoint (403)', () => {
    jest.spyOn(reflector, 'get').mockReturnValue(['MANAGER']);
    const req = mockRequest({ role: 'EMPLOYEE' });
    const ctx = mockContext(req);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('UT-SEC-005 — RbacGuard allows ADMIN on MANAGER-only endpoint (role hierarchy)', () => {
    jest.spyOn(reflector, 'get').mockReturnValue(['MANAGER']);
    const req = mockRequest({ role: 'ADMIN' });
    const ctx = mockContext(req);
    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('UT-SEC-006 — RbacGuard allows MANAGER on MANAGER-only endpoint', () => {
    jest.spyOn(reflector, 'get').mockReturnValue(['MANAGER']);
    const req = mockRequest({ role: 'MANAGER' });
    const ctx = mockContext(req);
    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('allows access when no roles are required', () => {
    jest.spyOn(reflector, 'get').mockReturnValue(null);
    const req = mockRequest({ role: 'EMPLOYEE' });
    const ctx = mockContext(req);
    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });
});

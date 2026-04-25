import { ExecutionContext } from '@nestjs/common';
import { TenantScopeInterceptor, ClsService } from './tenant-scope.interceptor';
import { of } from 'rxjs';

describe('TenantScopeInterceptor', () => {
  let interceptor: TenantScopeInterceptor;
  let mockClsService: any;

  const mockContext = (user: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any);

  const mockCallHandler = {
    handle: () => of('next-called'),
  };

  beforeEach(() => {
    mockClsService = { run: jest.fn((cb) => cb()), set: jest.fn() };
    interceptor = new TenantScopeInterceptor(mockClsService);
  });

  it('UT-SEC-010 — TenantScopeInterceptor extracts tenantId from JWT and sets scope', () => {
    const ctx = mockContext({ tenantId: 'TENANT_A' });
    interceptor.intercept(ctx, mockCallHandler as any);
    expect(mockClsService.set).toHaveBeenCalledWith('tenantId', 'TENANT_A');
  });

  it('proceeds without setting tenantId if no user is found', () => {
    const ctx = mockContext(undefined);
    interceptor.intercept(ctx, mockCallHandler as any);
    expect(mockClsService.set).not.toHaveBeenCalled();
  });
});

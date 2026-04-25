import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OwnershipGuard } from './ownership.guard';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity';
import { TimeOffRequest } from '../../entities/time-off-request.entity';

describe('OwnershipGuard', () => {
  let guard: OwnershipGuard;

  const mockUserRepo = {
    findOne: jest.fn(),
  };

  const mockRequest = (user: any, params: any = {}) => ({
    user,
    params,
  });

  const mockContext = (req: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => null,
    getClass: () => null,
    getArgs: () => [],
    getArgByIndex: () => null,
    getType: () => 'http',
    getParent: () => null,
    getData: () => null,
  } as any);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OwnershipGuard,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    guard = module.get<OwnershipGuard>(OwnershipGuard);
    jest.clearAllMocks();
  });

  it('UT-SEC-007 — OwnershipGuard rejects when route employeeId ≠ req.user.userId', async () => {
    const req = mockRequest({ userId: 'ALICE_ID', role: 'EMPLOYEE' }, { employeeId: 'CHARLIE_ID' });
    const ctx = mockContext(req);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows access if employeeId matches userId', async () => {
    const req = mockRequest({ userId: 'u-alice', role: 'EMPLOYEE' }, { employeeId: 'ALICE_ID' });
    const ctx = mockContext(req);
    mockUserRepo.findOne.mockResolvedValue({ id: 'u-alice', employee_id: 'ALICE_ID', role: 'EMPLOYEE', tenant_id: 't1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('UT-SEC-008 — OwnershipGuard allows MANAGER to access their team members data', async () => {
    const req = mockRequest({ userId: 'u-bob', role: 'MANAGER' }, { employeeId: 'ALICE_ID' });
    const ctx = mockContext(req);
    mockUserRepo.findOne
      .mockResolvedValueOnce({ id: 'u-bob', employee_id: 'EMP-BOB', role: 'MANAGER', tenant_id: 't1' })
      .mockResolvedValueOnce({ id: 'u-alice', employee_id: 'ALICE_ID', manager_id: 'u-bob', tenant_id: 't1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('UT-SEC-009 — OwnershipGuard blocks MANAGER from accessing non-team employee data', async () => {
    const req = mockRequest({ userId: 'u-bob', role: 'MANAGER' }, { employeeId: 'DAVE_ID' });
    const ctx = mockContext(req);
    mockUserRepo.findOne
      .mockResolvedValueOnce({ id: 'u-bob', employee_id: 'EMP-BOB', role: 'MANAGER', tenant_id: 't1' })
      .mockResolvedValueOnce({ id: 'u-dave', employee_id: 'DAVE_ID', manager_id: 'u-other', tenant_id: 't1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});

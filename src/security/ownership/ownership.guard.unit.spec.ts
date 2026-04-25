import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OwnershipGuard } from './ownership.guard';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity';

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
    const req = mockRequest({ userId: 'ALICE_ID', role: 'EMPLOYEE' }, { employeeId: 'ALICE_ID' });
    const ctx = mockContext(req);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('UT-SEC-008 — OwnershipGuard allows MANAGER to access their team members data', async () => {
    const req = mockRequest({ userId: 'MANAGER_BOB', role: 'MANAGER' }, { employeeId: 'ALICE_ID' });
    const ctx = mockContext(req);
    mockUserRepo.findOne.mockResolvedValue({ id: 'ALICE_ID', manager_id: 'MANAGER_BOB' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('UT-SEC-009 — OwnershipGuard blocks MANAGER from accessing non-team employee data', async () => {
    const req = mockRequest({ userId: 'MANAGER_BOB', role: 'MANAGER' }, { employeeId: 'DAVE_ID' });
    const ctx = mockContext(req);
    mockUserRepo.findOne.mockResolvedValue({ id: 'DAVE_ID', manager_id: 'DIFFERENT_MANAGER' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});

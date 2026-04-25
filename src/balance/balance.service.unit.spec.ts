import { Test, TestingModule } from '@nestjs/testing';
import { BalanceService } from './balance.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { TimeOffRequest, RequestStatus } from '../entities/time-off-request.entity';
import { BalanceAuditLog, AuditSource } from '../entities/balance-audit-log.entity';

describe('BalanceService', () => {
  let service: BalanceService;
  
  // Mocks
  const mockLeaveBalanceRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockTimeOffRequestRepo = {
    createQueryBuilder: jest.fn(),
  };

  const mockAuditLogRepo = {
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockHcmClient = {
    getBalance: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(LeaveBalance), useValue: mockLeaveBalanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockTimeOffRequestRepo },
        { provide: getRepositoryToken(BalanceAuditLog), useValue: mockAuditLogRepo },
        { provide: 'HCM_CLIENT', useValue: mockHcmClient },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('getAvailableAtApproval', () => {
    const params = { tenantId: 't1', employeeId: 'e1', locationId: 'l1', leaveType: 'VACATION' };

    it('UT-BAL-001 — returns correct available days with no approved-but-undeducted requests', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 10.00 });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ sum: null }),
      };
      mockTimeOffRequestRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getAvailableAtApproval(params.tenantId, params.employeeId, params.locationId, params.leaveType);
      
      expect(result).toBe(10.00);
    });

    it('UT-BAL-002 — correctly subtracts approved-but-undeducted days', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 10.00 });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ sum: 5.00 }), // 3 + 2
      };
      mockTimeOffRequestRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getAvailableAtApproval(params.tenantId, params.employeeId, params.locationId, params.leaveType);
      
      expect(result).toBe(5.00);
    });

    it('UT-BAL-003 — excludes already-HCM-deducted requests (hcm_request_id IS NOT NULL)', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 10.00 });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ sum: 4.00 }), 
      };
      mockTimeOffRequestRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getAvailableAtApproval(params.tenantId, params.employeeId, params.locationId, params.leaveType);
      
      expect(result).toBe(6.00);
      expect(qbMock.andWhere).toHaveBeenCalledWith('req.hcm_request_id IS NULL');
    });

    it('UT-BAL-004 — returns 0 when approved-but-undeducted sum equals balance_days', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 5.00 });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ sum: 5.00 }),
      };
      mockTimeOffRequestRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getAvailableAtApproval(params.tenantId, params.employeeId, params.locationId, params.leaveType);
      
      expect(result).toBe(0.00);
    });

    it('UT-BAL-011 — handles fractional days correctly (DECIMAL arithmetic)', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 5.50 });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ sum: 2.50 }), // simulating precise decimal return
      };
      mockTimeOffRequestRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getAvailableAtApproval(params.tenantId, params.employeeId, params.locationId, params.leaveType);
      
      expect(result).toBe(3.00);
    });
  });

  describe('isFresh', () => {
    it('UT-BAL-005 — returns true when hcm_last_synced is within FRESHNESS_TTL', () => {
      const balance: any = { hcm_last_synced: new Date(Date.now() - 5 * 60 * 1000) }; // 5 mins ago
      expect(service.isFresh(balance)).toBe(true);
    });

    it('UT-BAL-006 — returns false when hcm_last_synced is older than FRESHNESS_TTL', () => {
      const balance: any = { hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000) }; // 20 mins ago
      expect(service.isFresh(balance)).toBe(false);
    });

    it('UT-BAL-007 — returns false when hcm_last_synced is exactly at TTL boundary', () => {
      const balance: any = { hcm_last_synced: new Date(Date.now() - 15 * 60 * 1000) }; // exactly 15 mins ago
      expect(service.isFresh(balance)).toBe(false);
    });
  });

  describe('refreshFromHcm', () => {
    const params = { tenantId: 't1', employeeId: 'e1', locationId: 'l1', leaveType: 'VACATION' };

    it('UT-BAL-008 — writes fetched balance and updates hcm_last_synced', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 6.00, hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000) });
      const mockAsOf = new Date();
      mockHcmClient.getBalance.mockResolvedValue({ days: 8.50, asOf: mockAsOf });
      mockLeaveBalanceRepo.save.mockResolvedValue(true);
      mockAuditLogRepo.create.mockImplementation(dto => dto);

      await service.refreshFromHcm(params.tenantId, params.employeeId, params.locationId, params.leaveType);

      expect(mockLeaveBalanceRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        balance_days: 8.50,
        hcm_last_synced: mockAsOf
      }));
      expect(mockAuditLogRepo.save).toHaveBeenCalledWith(expect.objectContaining({ source: AuditSource.SPOT_SYNC }));
    });

    it('UT-BAL-009 — discards out-of-order HCM response (asOf older than current hcm_last_synced)', async () => {
      const t2 = new Date();
      const t1 = new Date(Date.now() - 5 * 60 * 1000);
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 10.00, hcm_last_synced: t2 });
      
      mockHcmClient.getBalance.mockResolvedValue({ days: 12.00, asOf: t1 }); // older timestamp

      const result = await service.refreshFromHcm(params.tenantId, params.employeeId, params.locationId, params.leaveType);

      expect(mockLeaveBalanceRepo.save).not.toHaveBeenCalled();
      expect(mockAuditLogRepo.save).not.toHaveBeenCalled();
      expect(result.balance_days).toBe(10.00); // returns current unchanged
    });

    it('UT-BAL-010 — writes audit log with previous_days, new_days, and delta', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 6.00, hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000) });
      const mockAsOf = new Date();
      mockHcmClient.getBalance.mockResolvedValue({ days: 10.00, asOf: mockAsOf });
      mockLeaveBalanceRepo.save.mockResolvedValue(true);
      mockAuditLogRepo.create.mockImplementation(dto => dto);

      await service.refreshFromHcm(params.tenantId, params.employeeId, params.locationId, params.leaveType);

      expect(mockAuditLogRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        previous_days: 6.00,
        new_days: 10.00,
        delta: 4.00,
        source: AuditSource.SPOT_SYNC,
      }));
    });

    it('UT-BAL-012 — propagates HCM client errors (circuit-breaker open)', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({ balance_days: 6.00 });
      mockHcmClient.getBalance.mockRejectedValue(new Error('CircuitBreakerOpenError'));

      await expect(service.refreshFromHcm(params.tenantId, params.employeeId, params.locationId, params.leaveType))
        .rejects.toThrow('CircuitBreakerOpenError');
      
      expect(mockLeaveBalanceRepo.save).not.toHaveBeenCalled();
      expect(mockAuditLogRepo.save).not.toHaveBeenCalled();
    });
  });
});

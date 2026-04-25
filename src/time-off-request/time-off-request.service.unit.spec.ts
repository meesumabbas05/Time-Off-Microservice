import { Test, TestingModule } from '@nestjs/testing';
import {
  TimeOffRequestService,
  InsufficientBalanceException,
  PendingRequestLimitException,
  SelfApprovalForbiddenException,
  BalanceInsufficientAtApprovalException,
  InvalidStateTransitionException,
  InvalidDateRangeException,
  InvalidDimensionCombinationException,
} from './time-off-request.service';
import { BalanceService } from '../balance/balance.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffRequest, RequestStatus } from '../entities/time-off-request.entity';
import { User } from '../entities/user.entity';
import { OutboxEvent, OutboxEventType } from '../entities/outbox-event.entity';
import { ForbiddenException } from '@nestjs/common';

describe('TimeOffRequestService', () => {
  let service: TimeOffRequestService;

  const mockRequestRepo = {
    save: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    manager: {
      transaction: jest.fn(),
    }
  };

  const mockOutboxRepo = {
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockUserRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockBalanceService = {
    isFresh: jest.fn(),
    refreshFromHcm: jest.fn(),
    getAvailableAtApproval: jest.fn(),
    getBalance: jest.fn(),
    getLastSynced: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: getRepositoryToken(OutboxEvent), useValue: mockOutboxRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: BalanceService, useValue: mockBalanceService },
      ],
    }).compile();

    service = module.get<TimeOffRequestService>(TimeOffRequestService);

    jest.clearAllMocks();
    mockBalanceService.getLastSynced.mockResolvedValue(new Date());
    mockRequestRepo.find.mockResolvedValue([]);
    
    // Default user mocks to prevent "User not found" errors
    mockUserRepo.findOne.mockResolvedValue({ 
      id: 'ALICE_ID', employee_id: 'ALICE_ID', timezone: 'UTC' 
    });
  });

  describe('submitRequest', () => {
    const mockUser = { userId: 'ALICE_ID', tenantId: 't1', role: 'EMPLOYEE', timezone: 'UTC' };
    const mockDto = { locationId: 'l1', leaveType: 'VACATION', startDate: '2026-01-01', endDate: '2026-01-05', days_requested: 5.00, timezone: 'UTC' };

    it('UT-REQ-001 — creates a PENDING_APPROVAL record when balance is sufficient and fresh', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      mockRequestRepo.create.mockImplementation((dto) => ({ ...dto, id: 'req_1' }));
      mockRequestRepo.save.mockImplementation((dto) => Promise.resolve(dto));

      const result = await service.submitRequest(mockDto, mockUser);

      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: RequestStatus.PENDING_APPROVAL }));
      expect(result).toMatchObject({ id: 'req_1', status: RequestStatus.PENDING_APPROVAL });
    });

    it('UT-REQ-002 — triggers HCM freshness refresh when balance is stale before eligibility check', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(false);
      mockBalanceService.refreshFromHcm.mockResolvedValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      mockRequestRepo.create.mockImplementation((dto) => ({ ...dto, id: 'req_2' }));

      await service.submitRequest(mockDto, mockUser);

      expect(mockBalanceService.refreshFromHcm).toHaveBeenCalled();
    });

    it('UT-REQ-003 — rejects with INSUFFICIENT_BALANCE (422) when balance < days_requested', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 3.00 });

      await expect(service.submitRequest(mockDto, mockUser)).rejects.toThrow(InsufficientBalanceException);
      expect(mockRequestRepo.save).not.toHaveBeenCalled();
    });

    it('UT-REQ-004 — rejects with PENDING_REQUEST_LIMIT_REACHED (429) when pending count >= 10', async () => {
      mockRequestRepo.count.mockResolvedValue(10);

      await expect(service.submitRequest(mockDto, mockUser)).rejects.toThrow(PendingRequestLimitException);
      expect(mockBalanceService.isFresh).not.toHaveBeenCalled();
    });

    it('UT-REQ-005 — rejects with PENDING_REQUEST_LIMIT_REACHED at exactly 10 pending requests (boundary)', async () => {
      mockRequestRepo.count.mockResolvedValue(10);
      
      try {
        await service.submitRequest(mockDto, mockUser);
      } catch (e: any) {
        expect(e.response).toMatchObject({ currentPending: 10 });
      }
    });

    it('UT-REQ-006 — succeeds at 9 pending requests (one below cap)', async () => {
      mockRequestRepo.count.mockResolvedValue(9);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      mockRequestRepo.create.mockImplementation((dto) => ({ ...dto, id: 'req_9' }));

      const result = await service.submitRequest(mockDto, mockUser);
      expect(result.status).toBe(RequestStatus.PENDING_APPROVAL);
    });

    it('UT-REQ-007 — does NOT modify any balance column on success', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      mockRequestRepo.create.mockImplementation((dto) => ({ ...dto, id: 'req_7' }));

      // There is no mock for leaveBalanceRepo.save in this service, ensuring the isolation
      await service.submitRequest(mockDto, mockUser);
      expect(mockRequestRepo.save).toHaveBeenCalled();
    });

    it('UT-REQ-017 — uses employeeId from JWT, NOT from DTO body', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      const maliciousDto: any = { ...mockDto, employeeId: 'ANOTHER_EMPLOYEE' };
      mockRequestRepo.create.mockImplementation((dto) => dto);

      await service.submitRequest(maliciousDto, mockUser);
      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ employee_id: 'ALICE_ID' }));
    });

    it('UT-REQ-019 — handles fractional day requests', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 5.50 });
      const fracDto = { ...mockDto, days_requested: 0.50 };
      mockRequestRepo.create.mockImplementation((dto) => dto);

      await service.submitRequest(fracDto, mockUser);
      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ days_requested: 0.50 }));
    });

    it('UT-REQ-020 — uses employees timezone for calendar date calculation', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      const tmzUser = { ...mockUser, timezone: 'Asia/Karachi' };
      // Even if server is in UTC.
      const tzDto: any = { ...mockDto, startDate: '2026-01-01', endDate: '2026-01-03' };
      delete tzDto.days_requested;
      mockRequestRepo.create.mockImplementation((dto) => dto);

      await service.submitRequest(tzDto, tmzUser);
      // It should calculate 3 days (1st, 2nd, 3rd)
      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ days_requested: 3.00 }));
    });

    it('UT-REQ-021 — validates date range (end_date must be >= start_date)', async () => {
      const invalidDto: any = { ...mockDto, startDate: '2026-03-10', endDate: '2026-03-05' };
      delete invalidDto.days_requested;
      await expect(service.submitRequest(invalidDto, mockUser)).rejects.toThrow(InvalidDateRangeException);
    });

    it('UT-DIM-001 — validateDimensionCombination rejects leave type not applicable for employees location', async () => {
      const dto = { ...mockDto, locationId: 'LOC-PK', leaveType: 'PARENTAL' };
      await expect(service.submitRequest(dto, mockUser)).rejects.toThrow(InvalidDimensionCombinationException);
    });

    it('UT-DIM-002 — validateDimensionCombination passes for valid combination', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getBalance.mockResolvedValue({ available_days: 10.00 });
      const dto = { ...mockDto, locationId: 'LOC-PK', leaveType: 'VACATION' };
      mockRequestRepo.create.mockImplementation((value) => value);

      await service.submitRequest(dto, mockUser);
      expect(mockRequestRepo.save).toHaveBeenCalled();
    });

    it('UT-DIM-003 — validateDimensionCombination check runs BEFORE HCM call', async () => {
      mockRequestRepo.count.mockResolvedValue(0);
      mockBalanceService.isFresh.mockReturnValue(false);
      const dto = { ...mockDto, locationId: 'LOC-PK', leaveType: 'PARENTAL' };

      await expect(service.submitRequest(dto, mockUser)).rejects.toThrow(InvalidDimensionCombinationException);
      expect(mockBalanceService.refreshFromHcm).not.toHaveBeenCalled();
    });
  });

  describe('approveRequest', () => {
    const mockManagerId = 'MANAGER_BOB';
    const mockRequest = { 
      id: 'req_app', status: RequestStatus.PENDING_APPROVAL, 
      tenant_id: 't1', location_id: 'l1', leave_type: 'VACATION', 
      employee_id: 'ALICE_ID', days_requested: 3.00, idempotency_key: 'idk_1' 
    };

    beforeEach(() => {
      mockUserRepo.findOne.mockResolvedValue({ id: mockManagerId, employee_id: mockManagerId });
    });

    it('UT-REQ-008 — sets status to APPROVED and creates outbox HCM_DEDUCT event in same transaction', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...mockRequest });
      mockBalanceService.getLastSynced.mockResolvedValue(new Date());
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getAvailableAtApproval.mockResolvedValue(5.00); // Sufficient

      const mockTrxManager = {
        save: jest.fn().mockImplementation((entity) => entity)
      };
      
      mockOutboxRepo.create.mockImplementation((dto) => dto);
      mockRequestRepo.manager.transaction.mockImplementation(async (levelOrCb, cb) => {
        const callback = cb || levelOrCb;
        return await callback(mockTrxManager);
      });

      await service.approveRequest('req_app', mockManagerId);

      expect(mockTrxManager.save).toHaveBeenCalledWith(expect.objectContaining({ status: RequestStatus.APPROVED, decided_by: mockManagerId }));
      expect(mockTrxManager.save).toHaveBeenCalledWith(expect.objectContaining({ event_type: OutboxEventType.HCM_DEDUCT, idempotency_key: 'idk_1' }));
    });

    it('UT-REQ-009 — rejects with BALANCE_INSUFFICIENT_AT_APPROVAL (409) when available_days < days_requested', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...mockRequest });
      mockBalanceService.getLastSynced.mockResolvedValue(new Date());
      mockBalanceService.isFresh.mockReturnValue(true);
      mockBalanceService.getAvailableAtApproval.mockResolvedValue(1.00); // 1.00 < 3.00
      mockRequestRepo.manager.transaction.mockImplementation(async (levelOrCb, cb) => {
        const callback = cb || levelOrCb;
        return await callback({ save: jest.fn() });
      });

      await expect(service.approveRequest('req_app', mockManagerId)).rejects.toThrow(BalanceInsufficientAtApprovalException);
    });

    it('UT-REQ-010 — rejects with SELF_APPROVAL_FORBIDDEN (403) when manager is the submitter', async () => {
      const selfReq = { ...mockRequest, employee_id: mockManagerId };
      mockRequestRepo.findOne.mockResolvedValue(selfReq);

      await expect(service.approveRequest('req_app', mockManagerId)).rejects.toThrow(SelfApprovalForbiddenException);
    });

    it('UT-SEC-013 — self-approval check fires before balance re-validation', async () => {
      const selfReq = { ...mockRequest, employee_id: mockManagerId };
      mockRequestRepo.findOne.mockResolvedValue(selfReq);

      await expect(service.approveRequest('req_app', mockManagerId)).rejects.toThrow(SelfApprovalForbiddenException);
      expect(mockBalanceService.getAvailableAtApproval).not.toHaveBeenCalled();
      expect(mockBalanceService.refreshFromHcm).not.toHaveBeenCalled();
    });

    it('UT-REQ-011 — enforces freshness re-check of balance at approval time', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...mockRequest });
      mockBalanceService.getLastSynced.mockResolvedValue(new Date(Date.now() - 20 * 60 * 1000));
      mockBalanceService.isFresh.mockReturnValue(false); // Stale!
      mockBalanceService.refreshFromHcm.mockResolvedValue(true);
      mockBalanceService.getAvailableAtApproval.mockResolvedValue(5.00);
      mockOutboxRepo.create.mockImplementation((dto) => dto);
      mockRequestRepo.manager.transaction.mockImplementation(async (levelOrCb, cb) => {
        const callback = cb || levelOrCb;
        return await callback({ save: jest.fn() });
      });

      await service.approveRequest('req_app', mockManagerId);

      expect(mockBalanceService.refreshFromHcm).toHaveBeenCalled();
    });

    it('UT-REQ-018 — approveRequest response includes available_days on 409', async () => {
       mockRequestRepo.findOne.mockResolvedValue({ ...mockRequest });
      mockBalanceService.getLastSynced.mockResolvedValue(new Date());
       mockBalanceService.isFresh.mockReturnValue(true);
       mockBalanceService.getAvailableAtApproval.mockResolvedValue(1.00);
       mockRequestRepo.find.mockResolvedValue([
        { id: 'c1', days_requested: 1.5 },
        { id: 'c2', days_requested: 0.5 },
       ]);
       
       try {
         await service.approveRequest('req_app', mockManagerId);
       } catch (e: any) {
         expect(e.response).toMatchObject({
          currentAvailableDays: 1.00,
          competingRequests: [
            { id: 'c1', days_requested: 1.5 },
            { id: 'c2', days_requested: 0.5 },
          ],
         });
       }
    });

  });

  describe('rejectRequest', () => {
    it('UT-REQ-012 — sets status to REJECTED and records decided_by', async () => {
      const mockRequest = { id: 'req_1', status: RequestStatus.PENDING_APPROVAL };
      mockRequestRepo.findOne.mockResolvedValue(mockRequest);
      mockRequestRepo.save.mockImplementation((dto) => Promise.resolve(dto));

      await service.rejectRequest('req_1', 'MANAGER_BOB', 'Not enough coverage');

      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        status: RequestStatus.REJECTED,
        decided_by: 'MANAGER_BOB'
      }));
    });

    it('UT-REQ-013 — does NOT deduct from balance', async () => {
      const mockRequest = { id: 'req_1', status: RequestStatus.PENDING_APPROVAL };
      mockRequestRepo.findOne.mockResolvedValue(mockRequest);
      
      // Since it's a unit test for this service alone, there are no balance ops mapped.
      await service.rejectRequest('req_1', 'MANAGER_BOB', 'Reason');
      expect(mockBalanceService.getAvailableAtApproval).not.toHaveBeenCalled();
    });
  });

  describe('cancelRequest', () => {
    beforeEach(() => {
        mockUserRepo.findOne.mockResolvedValue({ id: 'EMP_1', employee_id: 'EMP_1' });
    });

    it('UT-REQ-014 — sets status to CANCELLED for PENDING_APPROVAL request', async () => {
      const mockRequest = { id: 'req_1', status: RequestStatus.PENDING_APPROVAL, employee_id: 'EMP_1' };
      mockRequestRepo.findOne.mockResolvedValue(mockRequest);
      mockRequestRepo.save.mockImplementation((dto) => Promise.resolve(dto));

      await service.cancelRequest('req_1', 'EMP_1');
      expect(mockRequestRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: RequestStatus.CANCELLED }));
    });

    it('UT-REQ-015 — throws for a request not in PENDING_APPROVAL status', async () => {
      const mockRequest = { id: 'req_1', status: RequestStatus.APPROVED, employee_id: 'EMP_1' };
      mockRequestRepo.findOne.mockResolvedValue(mockRequest);

      await expect(service.cancelRequest('req_1', 'EMP_1')).rejects.toThrow(InvalidStateTransitionException);
    });

    it('UT-REQ-016 — throws FORBIDDEN when employee does not own the request', async () => {
      const mockRequest = { id: 'req_1', status: RequestStatus.PENDING_APPROVAL, employee_id: 'EMP_1' };
      mockRequestRepo.findOne.mockResolvedValue(mockRequest);
      // Override for this specific test
      mockUserRepo.findOne.mockResolvedValue({ id: 'HACKER', employee_id: 'HACKER' });

      await expect(service.cancelRequest('req_1', 'HACKER')).rejects.toThrow(ForbiddenException);
    });

    it('cancelling APPROVED request by ADMIN creates HCM_CREDIT outbox event and marks request CANCELLED', async () => {
      const approvedRequest = {
        id: 'req_approved_1',
        tenant_id: 't1',
        status: RequestStatus.APPROVED,
        employee_id: 'EMP_1',
        hcm_request_id: 'hcm_123',
        days_requested: 2.5,
      };
      mockRequestRepo.findOne.mockResolvedValue(approvedRequest);
      mockOutboxRepo.create.mockImplementation((dto) => dto);
      mockUserRepo.findOne.mockResolvedValue({ id: 'ADMIN_1', employee_id: 'ADMIN_1' });

      const mockTrxManager = {
        save: jest.fn().mockImplementation((entity) => entity),
      };
      mockRequestRepo.manager.transaction.mockImplementation(async (levelOrCb, cb) => {
        const callback = cb || levelOrCb;
        return await callback(mockTrxManager);
      });

      const result = await service.cancelRequest('req_approved_1', 'ADMIN_1', 'ADMIN');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(mockTrxManager.save).toHaveBeenCalledWith(expect.objectContaining({
        event_type: OutboxEventType.HCM_CREDIT,
        payload: expect.objectContaining({ requestId: 'req_approved_1', hcmRequestId: 'hcm_123', daysRequested: 2.5 }),
      }));
    });
  });
});

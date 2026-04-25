import { Test, TestingModule } from '@nestjs/testing';
import { ReconciliationService } from './reconciliation.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { BalanceAuditLog, AuditSource } from '../entities/balance-audit-log.entity';
import { Logger } from '@nestjs/common';

describe('ReconciliationService', () => {
  let service: ReconciliationService;

  const mockLeaveBalanceRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockAuditLogRepo = {
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockAlertService = {
    notifyLargeDrift: jest.fn(),
  };

  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: getRepositoryToken(LeaveBalance), useValue: mockLeaveBalanceRepo },
        { provide: getRepositoryToken(BalanceAuditLog), useValue: mockAuditLogRepo },
        { provide: 'ALERT_SERVICE', useValue: mockAlertService },
      ],
    }).compile();

    service = module.get<ReconciliationService>(ReconciliationService);
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    jest.clearAllMocks();
  });

  describe('reconcileBatch', () => {
    const hcmDate = new Date();
    const batchPayload = {
      tenant_id: 't1',
      hcm_as_of: hcmDate.toISOString(),
      records: [
        { employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION', hcm_balance: 10.00 }
      ]
    };

    it('UT-REC-001 & UT-REC-003 — overwrites TOMS balance_days with HCM truth when there is a discrepancy', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({
        tenant_id: 't1', employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION', balance_days: 8.00 // Discrepancy!
      });
      mockLeaveBalanceRepo.save.mockImplementation(dto => dto);
      mockAuditLogRepo.create.mockImplementation(dto => dto);

      await service.reconcileBatch(batchPayload);

      expect(mockLeaveBalanceRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        balance_days: 10.00,
        hcm_last_synced: expect.any(Date)
      }));
    });

    it('UT-REC-002 — logs RECONCILIATION audit event with delta when discrepancy found', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({
        id: 'bal_1', tenant_id: 't1', employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION', balance_days: 12.00 // Discrepancy!
      });
      mockLeaveBalanceRepo.save.mockImplementation(dto => dto);
      mockAuditLogRepo.create.mockImplementation(dto => dto);

      await service.reconcileBatch(batchPayload);

      expect(mockAuditLogRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        previous_days: 12.00,
        new_days: 10.00,
        delta: -2.00,
        source: AuditSource.RECONCILIATION,
        actor: 'HCM',
        reference_id: 'bal_1'
      }));
    });

    it('UT-REC-004 — does nothing if TOMS balance matches HCM truth', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({
        tenant_id: 't1', employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION', balance_days: 10.00 // Matches exactly
      });

      await service.reconcileBatch(batchPayload);

      // It might update `hcm_last_synced`, but per TRD testing, no reconciliation event or delta modification occurs.
      expect(mockAuditLogRepo.save).not.toHaveBeenCalled();
    });

    it('does not reconcile when drift is within 0.5 threshold', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({
        tenant_id: 't1', employee_id: 'e1', location_id: 'l1', leave_type: 'VACATION', balance_days: 10.4
      });

      await service.reconcileBatch(batchPayload);

      expect(mockAuditLogRepo.save).not.toHaveBeenCalled();
      expect(mockLeaveBalanceRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        balance_days: 10.4,
        hcm_last_synced: expect.any(Date),
      }));
    });

    it('UT-REC-005 — safely handles batch payloads missing records (logs warning, does not fail)', async () => {
      const emptyPayload = { tenant_id: 't1', hcm_as_of: new Date().toISOString(), records: [] };
      
      await expect(service.reconcileBatch(emptyPayload)).resolves.not.toThrow();
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or empty records'));
      expect(mockLeaveBalanceRepo.findOne).not.toHaveBeenCalled();
    });

    it('gracefully creates a new balanced record if TOMS did not previously have it', async () => {
        // Edge case: HCM tells us someone has a balance but they've never requested time off through TOMS yet.
        mockLeaveBalanceRepo.findOne.mockResolvedValue(null);
        mockLeaveBalanceRepo.create.mockImplementation(dto => dto);
        mockLeaveBalanceRepo.save.mockImplementation(dto => dto);
        mockAuditLogRepo.create.mockImplementation(dto => dto);
  
        await service.reconcileBatch(batchPayload);
        
        expect(mockLeaveBalanceRepo.save).toHaveBeenCalledWith(expect.objectContaining({ balance_days: 10.00 }));
        expect(mockAuditLogRepo.save).toHaveBeenCalledWith(expect.objectContaining({
          previous_days: 0.00,
          new_days: 10.00,
          delta: 10.00,
          source: AuditSource.RECONCILIATION
        }));
    });

    it('sends alert when discrepancy is greater than 5 days', async () => {
      mockLeaveBalanceRepo.findOne.mockResolvedValue({
        id: 'bal_alert',
        tenant_id: 't1',
        employee_id: 'e1',
        location_id: 'l1',
        leave_type: 'VACATION',
        balance_days: 2.0,
      });
      mockLeaveBalanceRepo.save.mockImplementation((dto) => dto);
      mockAuditLogRepo.create.mockImplementation((dto) => dto);

      await service.reconcileBatch(batchPayload);

      expect(mockAlertService.notifyLargeDrift).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: 't1',
        employee_id: 'e1',
        difference: 8,
      }));
    });
  });
});

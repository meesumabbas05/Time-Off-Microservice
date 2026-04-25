import { TENANT_A_ID } from './users';

export const ALICE_VACATION_BALANCE = {
  id: 'lb-alice-vacation-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-001',
  location_id: 'LOC-PK',
  leave_type: 'VACATION',
  balance_days: 10.00,
  hcm_last_synced: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago (fresh)
};

export const CHARLIE_VACATION_BALANCE = {
  id: 'lb-charlie-vacation-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-003',
  location_id: 'LOC-GB',
  leave_type: 'VACATION',
  balance_days: 3.00,
  hcm_last_synced: new Date(Date.now() - 5 * 60 * 1000),
};

export const STALE_BALANCE = (base: any) => ({
  ...base,
  hcm_last_synced: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago (stale)
});

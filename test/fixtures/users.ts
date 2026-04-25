export const TENANT_A_ID = 'tenant-a-uuid-1111';
export const TENANT_B_ID = 'tenant-b-uuid-2222';

export const EMPLOYEE_ALICE = {
  id: 'user-alice-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-001',
  email: 'alice@example.com',
  role: 'EMPLOYEE',
  manager_id: 'user-bob-uuid',
  timezone: 'Asia/Karachi',
  location_id: 'LOC-PK',
};

export const MANAGER_BOB = {
  id: 'user-bob-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-002',
  email: 'bob@example.com',
  role: 'MANAGER',
  manager_id: null,
  timezone: 'America/New_York',
  location_id: 'LOC-US',
};

export const EMPLOYEE_CHARLIE = {
  id: 'user-charlie-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-003',
  email: 'charlie@example.com',
  role: 'EMPLOYEE',
  manager_id: 'user-bob-uuid',
  timezone: 'Europe/London',
  location_id: 'LOC-GB',
};

export const ADMIN_EVE = {
  id: 'user-eve-uuid',
  tenant_id: TENANT_A_ID,
  employee_id: 'EMP-004',
  email: 'eve@example.com',
  role: 'ADMIN',
  manager_id: null,
  timezone: 'UTC',
  location_id: 'LOC-US',
};

export const EMPLOYEE_DAVE = {
  id: 'user-dave-uuid',
  tenant_id: TENANT_B_ID,   // Different tenant!
  employee_id: 'EMP-B-001',
  email: 'dave@other.com',
  role: 'EMPLOYEE',
  manager_id: null,
  timezone: 'UTC',
  location_id: 'LOC-US',
};

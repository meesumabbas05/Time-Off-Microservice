import * as jwt from 'jsonwebtoken';
import { EMPLOYEE_ALICE, MANAGER_BOB, ADMIN_EVE, EMPLOYEE_CHARLIE, EMPLOYEE_DAVE, TENANT_A_ID, TENANT_B_ID } from './users';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

export function signToken(user: { id: string; tenantId: string; role: string }): string {
  const payload = { userId: user.id, tenantId: user.tenantId, role: user.role };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', subject: user.id });
}

export const ALICE_TOKEN   = signToken({ id: EMPLOYEE_ALICE.id, tenantId: TENANT_A_ID, role: 'EMPLOYEE' });
export const BOB_TOKEN     = signToken({ id: MANAGER_BOB.id, tenantId: TENANT_A_ID, role: 'MANAGER' });
export const EVE_TOKEN     = signToken({ id: ADMIN_EVE.id, tenantId: TENANT_A_ID, role: 'ADMIN' });
export const CHARLIE_TOKEN = signToken({ id: EMPLOYEE_CHARLIE.id, tenantId: TENANT_A_ID, role: 'EMPLOYEE' });
export const DAVE_TOKEN    = signToken({ id: EMPLOYEE_DAVE.id, tenantId: TENANT_B_ID, role: 'EMPLOYEE' });

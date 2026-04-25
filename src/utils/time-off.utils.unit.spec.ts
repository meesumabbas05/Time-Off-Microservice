import * as crypto from 'crypto';
import { computeBusinessDays, verifyHmac, decimalSubtract } from './time-off.utils';

describe('TimeOff utilities', () => {
  it('UT-UTL-001 — computeBusinessDays returns correct count for date range in UTC+5 timezone', () => {
    const result = computeBusinessDays('2026-01-05', '2026-01-09', 'Asia/Karachi');
    expect(result).toBe(5);
  });

  it('UT-UTL-002 — computeBusinessDays correctly handles DST boundary for timezone-aware calculation', () => {
    const result = computeBusinessDays('2026-03-06', '2026-03-10', 'America/New_York');
    expect(result).toBe(3);
  });

  it('UT-UTL-003 — verifyHmac returns true for valid signature', () => {
    const payload = JSON.stringify({ test: 'data' });
    const secret = 'secret';
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyHmac(payload, secret, signature)).toBe(true);
  });

  it('UT-UTL-004 — verifyHmac returns false for tampered payload', () => {
    const payload = JSON.stringify({ test: 'data' });
    const secret = 'secret';
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyHmac(JSON.stringify({ test: 'tampered' }), secret, signature)).toBe(false);
  });

  it('UT-UTL-005 — decimalSubtract performs exact subtraction without floating-point error', () => {
    expect(decimalSubtract(10.1, 0.1)).toBe(10);
  });
});

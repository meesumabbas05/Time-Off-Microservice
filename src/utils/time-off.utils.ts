import * as crypto from 'crypto';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export function computeBusinessDays(startDate: string, endDate: string, timezone: string): number {
  const startUtc = fromZonedTime(`${startDate}T00:00:00`, timezone);
  const endUtc = fromZonedTime(`${endDate}T00:00:00`, timezone);

  let cursor = toZonedTime(startUtc, timezone);
  const end = toZonedTime(endUtc, timezone);

  let count = 0;
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      count += 1;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  return count;
}

export function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}

export function decimalSubtract(a: number, b: number): number {
  const scale = 100;
  return (Math.round(a * scale) - Math.round(b * scale)) / scale;
}

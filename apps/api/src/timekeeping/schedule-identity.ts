import { createHash } from 'node:crypto';

/** UUIDv8, stable namespace and weekday identity for centrally created versions. */
export function scheduleWeekdayId(versionId: string, dayOfWeek: number) {
  const bytes = createHash('sha256')
    .update(`hexpayroll:schedule-day:v1:${versionId.toLowerCase()}:${dayOfWeek}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

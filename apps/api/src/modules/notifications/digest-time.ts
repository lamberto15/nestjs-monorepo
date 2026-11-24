import { wallClock, zonedMoment } from '../../core/time/zoned-time.js';
import type { DigestMode } from './notifications.types.js';

const DAY = 86_400_000;

/**
 * When a digest mail flagged at `now` is due: an hourly one at once (the
 * hourly job sends what is due); a daily one at the next `hour`:00 of the
 * recipient's time zone (today's, if still ahead; else tomorrow's).
 */
export function nextDigestTime(
  mode: DigestMode,
  now: Date,
  timeZone: string,
  hour: number,
): Date {
  if (mode === 'hourly') {
    return now;
  }
  const time = now.getTime();
  const today = wallClock(time, timeZone).date;
  const due = zonedMoment(today, hour * 60, timeZone);
  if (due > time) {
    return new Date(due);
  }
  const tomorrow = wallClock(time + DAY, timeZone).date;
  return new Date(zonedMoment(tomorrow, hour * 60, timeZone));
}

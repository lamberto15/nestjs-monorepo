import { wallClock, zonedInstant } from '../../core/time/zoned-time.js';

/** Moments as a reader's wall clock and back, for files (core/time's clock). */
const two = (n: number) => String(n).padStart(2, '0');

/** The wall-clock day, `HH:MM:SS` and milliseconds (`123`) of a moment in `timeZone`. */
export function fileClock(date: Date, timeZone: string) {
  const clock = wallClock(date, timeZone);
  return {
    date: clock.date,
    time: `${two(clock.hour)}:${two(clock.minute)}:${two(clock.second)}`,
    ms: String(clock.ms).padStart(3, '0'),
  };
}

/**
 * A moment as people read it in `timeZone`, `2026-10-15 18:30:00`:
 * spreadsheets take it for a date and time (an offset would make it text).
 * The zone goes in the column's header.
 */
export function localDateTime(date: Date, timeZone: string) {
  const { date: day, time } = fileClock(date, timeZone);
  return `${day} ${time}`;
}

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * A wall-clock time of `timeZone` (`2026-10-15 18:30:00`, what a zoned
 * column holds) as the moment, in ISO 8601 UTC; undefined when it isn't
 * one (left to the record's schema). A time the clock repeats gives the
 * earlier moment; one it skips, the moment after the gap.
 */
export function instantOf(text: string, timeZone: string) {
  const match = WALL_CLOCK.exec(text.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = '0', ms = '0'] = match;
  const asUtc = Date.UTC(
    +year!,
    +month! - 1,
    +day!,
    +hour!,
    +minute!,
    +second,
    +ms.padEnd(3, '0'),
  );
  const date = new Date(asUtc);
  if (date.getUTCDate() !== +day! || date.getUTCHours() !== +hour!) {
    return undefined; // 2026-02-30, 25:00
  }
  return new Date(zonedInstant(asUtc, timeZone)).toISOString();
}

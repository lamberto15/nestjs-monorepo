/**
 * Moments as a reader's wall clock and back, for files: Intl, no date
 * library (Node has no Temporal yet). Kept apart from calendars' helpers:
 * a file needs the seconds, the milliseconds and the offset, and the way
 * back from a cell.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock day, time and milliseconds of a moment in `timeZone`. */
export function wallClock(date: Date, timeZone: string) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
    });
    formats.set(timeZone, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(date).map(({ type, value }) => [type, value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    time: `${part.hour}:${part.minute}:${part.second}`,
    ms: part.fractionalSecond,
  };
}

/**
 * A moment as people read it in `timeZone`, `2026-10-15 18:30:00`:
 * spreadsheets take it for a date and time (an offset would make it text).
 * The zone goes in the column's header.
 */
export function localDateTime(date: Date, timeZone: string) {
  const { date: day, time } = wallClock(date, timeZone);
  return `${day} ${time}`;
}

/** The milliseconds `timeZone` is ahead of UTC at `time`. */
function offsetAt(time: number, timeZone: string) {
  const { date, time: clock, ms } = wallClock(new Date(time), timeZone);
  return Date.parse(`${date}T${clock}.${ms}Z`) - time;
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
  const DAY = 86_400_000;
  const candidates = [
    asUtc - offsetAt(asUtc - DAY, timeZone),
    asUtc - offsetAt(asUtc + DAY, timeZone),
  ];
  const real = candidates.filter(
    (moment) => moment + offsetAt(moment, timeZone) === asUtc,
  );
  const time = real.length ? Math.min(...real) : Math.max(...candidates);
  return new Date(time).toISOString();
}

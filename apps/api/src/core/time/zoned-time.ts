/**
 * Moments as a time zone's wall clock and back: Intl, no date library
 * (Node has no Temporal yet). Calendars, schedules, digests and files all
 * read the clock the same way; this is that one way.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;

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

/** The wall-clock date (YYYY-MM-DD) and time of the moment `time` in `timeZone`. */
export function wallClock(time: number | Date, timeZone: string) {
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
    format
      .formatToParts(typeof time === 'number' ? new Date(time) : time)
      .map(({ type, value }) => [type, value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    hour: +part.hour,
    minute: +part.minute,
    second: +part.second,
    ms: +part.fractionalSecond,
  };
}

/** The milliseconds `timeZone` is ahead of UTC at `time`. */
function offsetAt(time: number, timeZone: string) {
  const { date, hour, minute, second, ms } = wallClock(time, timeZone);
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!, hour, minute, second, ms) - time;
}

/**
 * The moment the clock of `timeZone` shows `asUtc` read as a wall-clock
 * time (Date.UTC of its parts). The offset is read at the moment itself,
 * so a daylight-saving change is followed: a time the clock repeats gives
 * its first occurrence, one it skips the moment after the gap (as
 * Temporal's "compatible" does).
 */
export function zonedInstant(asUtc: number, timeZone: string) {
  const candidates = [
    asUtc - offsetAt(asUtc - DAY, timeZone),
    asUtc - offsetAt(asUtc + DAY, timeZone),
  ];
  const real = candidates.filter(
    (moment) => moment + offsetAt(moment, timeZone) === asUtc,
  );
  return real.length ? Math.min(...real) : Math.max(...candidates);
}

/** The moment the clock of `timeZone` shows `minute` (since midnight, up to 1440) on `date` (YYYY-MM-DD). */
export const zonedMoment = (date: string, minute: number, timeZone: string) =>
  zonedInstant(Date.parse(`${date}T00:00:00Z`) + minute * MINUTE, timeZone);

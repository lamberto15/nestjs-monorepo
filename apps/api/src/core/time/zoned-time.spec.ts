import { isTimeZone, wallClock, zonedMoment } from './zoned-time.js';

describe('zonedMoment', () => {
  it('moves a time the clock skips to the moment after the gap', () => {
    // 02:30 on 2026-03-08 does not exist in New York: 03:30 EDT.
    expect(
      new Date(
        zonedMoment('2026-03-08', 150, 'America/New_York'),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });

  it('takes the first of a time the clock repeats', () => {
    // 01:30 on 2026-11-01 happens twice: the EDT one.
    expect(
      new Date(zonedMoment('2026-11-01', 90, 'America/New_York')).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reads 24:00 as the next midnight', () => {
    expect(new Date(zonedMoment('2026-10-23', 1440, 'UTC')).toISOString()).toBe(
      '2026-10-24T00:00:00.000Z',
    );
  });
});

describe('wallClock', () => {
  it('reads the date and time of a moment in a zone, to the millisecond', () => {
    expect(
      wallClock(Date.parse('2026-03-08T07:30:15.250Z'), 'America/New_York'),
    ).toEqual({ date: '2026-03-08', hour: 3, minute: 30, second: 15, ms: 250 });
    expect(
      wallClock(new Date('2026-12-31T23:00:00Z'), 'Europe/Berlin'),
    ).toMatchObject({
      date: '2027-01-01',
      hour: 0,
    });
  });

  it('knows the zones of this runtime', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

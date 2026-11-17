import { defineQuota, periodOf } from './quota.js';

describe('quotas', () => {
  it('finds when a day and a month start again, in UTC', () => {
    const now = new Date('2026-12-31T23:30:00Z');
    expect(periodOf('day', now)).toEqual({
      id: '2026-12-31',
      resetsAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(periodOf('month', now)).toEqual({
      id: '2026-12',
      resetsAt: new Date('2027-01-01T00:00:00Z'),
    });
  });

  it('refuses a key that cannot be a JSON member of the limits', () => {
    expect(() =>
      defineQuota({
        key: 'Mail per day',
        label: 'x',
        kind: 'rate',
        period: 'day',
      }),
    ).toThrow(/Quota key/);
    expect(
      defineQuota({
        key: 'mail.perDay',
        label: 'x',
        kind: 'rate',
        period: 'day',
      }).key,
    ).toBe('mail.perDay');
  });
});

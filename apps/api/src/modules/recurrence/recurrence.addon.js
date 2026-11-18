// The `recurrence` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons recurrence` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE } from '../../../schematics/feature/kit.js';

export default {
  order: 240,
  about: 'records created on a schedule',
  imports: { RecurrenceModule: 'modules/recurrence/recurrence.module.js' },
  call: (c) => `RecurrenceModule.forRecord(${c.R})`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    RecurrenceModule: 'modules/recurrence/recurrence.module.js',
  },
  test: (c) => `
it('recurrence: a schedule of records is made', async () => {
  const schedule = await call('POST', '/v1/record-schedules', ${c.writer}, {
    name: 'Daily',
    target: '${c.t.plural}',
    template: sample(),
    rrule: 'FREQ=DAILY',
    startDate: '2020-01-01',
    time: '08:00',
  });
  expect(schedule.statusCode, schedule.body).toBe(201);
});`,
};

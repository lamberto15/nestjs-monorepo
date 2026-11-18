// The `ai` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons ai` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE } from '../../../schematics/feature/kit.js';

export default {
  order: 190,
  about: 'summarize or classify a record with a language model',
  imports: { AiModule: 'modules/ai/ai.module.js' },
  call: (c) => `AiModule.forRecord(${c.R})`,
  boot: { QueuesModule: CORE.QueuesModule, MetricsModule: CORE.MetricsModule },
  test: (c) => `
it('ai: a run is refused while no model is set up (ANTHROPIC_API_KEY)', async () => {
  const item = await create();
  const run = await call('POST', '/v1/ai/runs', ${c.writer}, { source: '${c.t.plural}', recordId: item.id, task: 'summarize' });
  expect(run.statusCode, run.body).toBe(503);
});`,
};

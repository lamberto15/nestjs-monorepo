// The `documents` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons documents` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { cap, CORE, WORKERS } from '../../../schematics/feature/kit.js';

/** Its PDF's page (modules/documents): Handlebars, wrapped in the module's layout. */
function pageTemplate(c) {
  return (
    '<!-- ' +
    cap(c.t.aNoun) +
    "'s PDF. Business logic: its layout; the context has\n" +
    '     title, record (field to text), rows and labels (modules/documents). -->\n' +
    '<header>\n  <p class="eyebrow">{{ labels.document }}</p>\n  <h1>{{ title }}</h1>\n</header>\n' +
    '<table class="facts">\n  {{#each rows}}\n  <tr>\n    <th>{{ this.label }}</th>\n    <td>{{ this.value }}</td>\n  </tr>\n  {{/each}}\n</table>\n' +
    '<footer>{{ labels.issued }}</footer>\n'
  );
}

export default {
  order: 180,
  about: "a record's PDF, from templates/<item>.html",
  imports: {
    DocumentsModule: 'modules/documents/documents.module.js',
    join: 'node:path',
  },
  call: (c) =>
    `DocumentsModule.forRecord(${c.R}, { template: '${c.t.singular}', dir: join(import.meta.dirname, 'templates') })`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    MetricsModule: CORE.MetricsModule,
    SharedHttpClientModule: CORE.SharedHttpClientModule,
    StorageModule: 'modules/storage/storage.module.js',
  },
  env: { ...WORKERS, STORAGE_DRIVER: 'memory' },
  test: (c) => `
it('documents: a record lists its PDFs', async () => {
  const item = await create();
  const documents = await call('GET', \`${c.url}/\${item.id}/documents\`, ${c.writer});
  expect(documents.statusCode, documents.body).toBe(200);
});`,
  routes: ['pdf', 'documents'],
  files: (c) => ({ ['templates/' + c.t.singular + '.html']: pageTemplate(c) }),
  readme: (c) => ['- `templates/' + c.t.singular + '.html`: the PDF.'],
};

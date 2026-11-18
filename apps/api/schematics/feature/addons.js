// What each add-on (`--addons`) adds to a generated feature: the import and
// its `forRecord()` in the feature module, the body and response pieces of
// recordSchemas(), a column of recordTable(), a file of the feature's own
// when the add-on needs one (an approval's effect, a PDF template…), what
// the generated e2e spec boots and sets, and its check there. Each add-on's
// README in src/modules/<name> is the contract this follows.

import { titleField } from './fields.js';

const ENCRYPTION = {
  DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
};
const WORKERS = { APP_ROLE: 'all', MAIL_TRANSPORT: 'memory', ...ENCRYPTION };

/** What the e2e spec boots besides testItemModules() (test/records.ts), by name, and where it is. */
export const BOOT = {
  QueuesModule: 'core/queues/queues.module.js',
  MetricsModule: 'core/metrics/metrics.module.js',
  SharedHttpClientModule: 'core/http-client/http-client.module.js',
  SharedWorkflowsModule: 'core/workflows/workflows.module.js',
  HoldsModule: 'iam/holds/holds.module.js',
  StorageModule: 'modules/storage/storage.module.js',
  NotificationsModule: 'modules/notifications/notifications.module.js',
  WebhooksModule: 'modules/webhooks/webhooks.module.js',
  AutomationsModule: 'modules/automations/automations.module.js',
  ChoicesModule: 'modules/choices/choices.module.js',
  RecurrenceModule: 'modules/recurrence/recurrence.module.js',
  RetentionModule: 'modules/retention/retention.module.js',
  McpModule: 'modules/mcp/mcp.module.js',
};

const mod = (folder, className) => ({
  [className]: `modules/${folder}/${folder}.module.js`,
});

/**
 * The add-ons, in the order the feature module imports them. `c` is the
 * generation's context (templates.js): `c.R` the declaration's constant,
 * `c.t` the names, `c.writer` who creates records in the spec.
 */
export const ADDONS = {
  tags: {
    about: 'labels set per record, `?tag=` on the list',
    imports: {
      ...mod('tags', 'TagsModule'),
      TAGS_RESPONSE: 'modules/tags/tags.schemas.js',
    },
    call: (c) => `TagsModule.forRecord(${c.R})`,
    response: ['TAGS_RESPONSE'],
    test: (c) => `
  it('tags: a tag set on one is shown with it', async () => {
    const item = await create();
    const tag = await call('POST', '/v1/tags', team.admin.headers, { subject: '${c.t.Singular}', name: 'Urgent' });
    expect(tag.statusCode, tag.body).toBe(201);
    const set = await call('PUT', \`${c.url}/\${item.id}/tags\`, ${c.writer}, { tagIds: [tag.json().id] });
    expect(set.statusCode, set.body).toBe(200);
    const read = await call('GET', \`${c.url}/\${item.id}\`, ${c.writer});
    expect(read.json().tags).toHaveLength(1);
  });`,
  },
  comments: {
    about: 'threads, mentions and replies on a record',
    imports: mod('comments', 'CommentsModule'),
    call: (c) => `CommentsModule.forRecord(${c.R})`,
    boot: ['QueuesModule'],
    env: WORKERS,
    test: (c) => `
  it('comments: one is added and listed', async () => {
    const item = await create();
    const added = await call('POST', \`${c.url}/\${item.id}/comments\`, ${c.writer}, { body: 'A first comment' });
    expect(added.statusCode, added.body).toBe(201);
    const listed = await call('GET', \`${c.url}/\${item.id}/comments\`, ${c.writer});
    expect(listed.json().items).toHaveLength(1);
  });`,
  },
  attachments: {
    about: 'files on a record, scanned and stored on the private disk',
    imports: mod('attachments', 'AttachmentsModule'),
    call: (c) => `AttachmentsModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'MetricsModule', 'StorageModule'],
    env: { ...WORKERS, STORAGE_DRIVER: 'memory' },
    test: (c) => `
  it('attachments: a record lists its files', async () => {
    const item = await create();
    const files = await call('GET', \`${c.url}/\${item.id}/attachments\`, ${c.writer});
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json().items).toEqual([]);
  });`,
  },
  revisions: {
    about: 'history of every change, comparable and restorable',
    imports: mod('revisions', 'RevisionsModule'),
    call: (c) => `RevisionsModule.forRecord(${c.R})`,
    test: (c) => `
  it('revisions: a new record has its first revision', async () => {
    const item = await create();
    const revisions = await call('GET', \`${c.url}/\${item.id}/revisions\`, ${c.writer});
    expect(revisions.statusCode, revisions.body).toBe(200);
    expect(revisions.json().items).toHaveLength(1);
  });`,
  },
  favorites: {
    about: 'people pin records they open often',
    imports: mod('favorites', 'FavoritesModule'),
    call: (c) => `FavoritesModule.forRecord(${c.R})`,
    test: (c) => `
  it('favorites: a record is pinned', async () => {
    const item = await create();
    const pinned = await call('POST', '/v1/favorites', ${c.writer}, { kind: 'record', subject: '${c.t.Singular}', target: item.id, label: 'Pinned' });
    expect(pinned.statusCode, pinned.body).toBe(201);
  });`,
  },
  recents: {
    about: 'the records a person opened lately',
    imports: mod('recents', 'RecentsModule'),
    call: (c) => `RecentsModule.forRecord(${c.R})`,
    test: (c) => `
  it('recents: an opened record is noted', async () => {
    const item = await create();
    const noted = await call('POST', '/v1/recents', ${c.writer}, { subject: '${c.t.Singular}', recordId: item.id, label: 'Opened' });
    expect(noted.statusCode, noted.body).toBeLessThan(300);
  });`,
  },
  templates: {
    about: 'saved values that prefill a create',
    imports: mod('templates', 'TemplatesModule'),
    call: (c) => `TemplatesModule.forRecord(${c.R})`,
    test: (c) => `
  it('templates: the record takes templates', async () => {
    const subjects = await call('GET', '/v1/templates/subjects', ${c.writer});
    expect(subjects.statusCode, subjects.body).toBe(200);
    expect(subjects.body).toContain('${c.t.Singular}');
  });`,
  },
  choices: {
    about: 'a field chosen from a provider (its first enum field)',
    check: (c) => {
      if (!c.enumField)
        throw new Error(
          '--addons choices: the feature needs an enum field to choose from.',
        );
    },
    imports: mod('choices', 'ChoicesModule'),
    own: (c) => ({
      [`${c.t.SINGULAR}_CHOICES`]: `./${c.t.singular}.choices.js`,
      [`${c.t.Singular}Choices`]: `./${c.t.singular}.choices.js`,
    }),
    call: (c) => `ChoicesModule.forRecord(${c.R}, ${c.t.SINGULAR}_CHOICES)`,
    providers: (c) => [`${c.t.Singular}Choices`],
    boot: ['ChoicesModule'],
    test: (c) => `
  it('choices: its ${c.enumField.name} offers its choices', async () => {
    const options = await call('GET', '/v1/choices/${c.t.singular}-${c.kebab(c.enumField.name)}/${c.enumField.name}/options', ${c.writer});
    expect(options.statusCode, options.body).toBe(200);
  });`,
  },
  'custom-fields': {
    about: 'fields administrators add at runtime',
    imports: {
      ...mod('custom-fields', 'CustomFieldsModule'),
      CUSTOM_FIELDS_BODY: 'modules/custom-fields/custom-fields.schemas.js',
      CUSTOM_FIELDS_RESPONSE: 'modules/custom-fields/custom-fields.schemas.js',
    },
    call: (c) => `CustomFieldsModule.forRecord(${c.R})`,
    body: ['CUSTOM_FIELDS_BODY'],
    response: ['CUSTOM_FIELDS_RESPONSE'],
    test: () => `
  it('custom fields: a record shows its custom values', async () => {
    const item = await create();
    expect(item.custom).toEqual({});
  });`,
  },
  'computed-fields': {
    about: 'values derived by an expression on every read',
    imports: {
      ...mod('computed-fields', 'ComputedFieldsModule'),
      computedResponse: 'modules/computed-fields/computed-fields.js',
    },
    own: (c) => ({
      [`${c.t.SINGULAR}_COMPUTED`]: `./${c.t.singular}.computed.js`,
    }),
    call: (c) =>
      `ComputedFieldsModule.forRecord(${c.R}, ${c.t.SINGULAR}_COMPUTED)`,
    response: (c) => [`computedResponse(${c.t.SINGULAR}_COMPUTED)`],
    test: (c) => {
      const title = titleField(c.fields);
      return title
        ? `
  it('computed fields: shown with the record', async () => {
    const item = await create();
    expect(item.${title.name}Length).toBe(String(item.${title.name}).length);
  });`
        : `
  it('computed fields: shown with the record', async () => {
    const item = await create();
    expect(item.edited).toBe(false);
  });`;
    },
  },
  approvals: {
    about: 'actions that need approval before they run (--approvals)',
    imports: mod('approvals', 'ApprovalsModule'),
    call: (c) =>
      `ApprovalsModule.forRecord(${c.R}, { ${c.approvals.map((a) => `${a.action}: { label: '${a.label}' }`).join(', ')} })`,
    own: (c) =>
      Object.fromEntries(
        c.approvals.map((a) => [a.className, `./${c.t.singular}.approvals.js`]),
      ),
    providers: (c) => c.approvals.map((a) => a.className),
    boot: ['QueuesModule', 'SharedWorkflowsModule'],
    env: WORKERS,
    test: (c) => `
  it('approvals: ${c.approvals[0].action} runs at once while its approval is off', async () => {
    const item = await create();
    const asked = await call('POST', \`${c.url}/\${item.id}/${c.approvals[0].path}\`, ${c.writer}, {});
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ status: 'applied' });
  });`,
  },
  acknowledgments: {
    about: '"I have read this", per version',
    imports: mod('acknowledgments', 'AcknowledgmentsModule'),
    call: (c) => `AcknowledgmentsModule.forRecord(${c.R})`,
    boot: ['QueuesModule'],
    env: WORKERS,
    test: (c) => `
  it('acknowledgments: a record has its dashboard', async () => {
    const item = await create();
    const dashboard = await call('GET', \`${c.url}/\${item.id}/acknowledgments\`, ${c.writer});
    expect(dashboard.statusCode, dashboard.body).toBe(200);
  });`,
  },
  bulk: {
    about: 'delete, restore or change many at once',
    imports: mod('bulk', 'BulkModule'),
    call: (c) => `BulkModule.forRecord(${c.R})`,
    boot: ['QueuesModule'],
    env: { APP_ROLE: 'all' },
    test: (c) => `
  it('bulk: deletes the records sent', async () => {
    const item = await create();
    const run = await call('POST', '${c.url}/bulk', ${c.writer}, { action: 'delete', ids: [item.id] });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({ done: 1 });
  });`,
  },
  merge: {
    about: 'find duplicates and merge them (needs the recycle bin)',
    check: (c) => {
      if (!c.softDelete)
        throw new Error(
          '--addons merge: a merged duplicate goes to the recycle bin; keep --soft-delete.',
        );
      if (!titleField(c.fields))
        throw new Error(
          '--addons merge: the feature needs a required string field to find duplicates by.',
        );
    },
    imports: mod('merge', 'MergeModule'),
    call: (c) => `MergeModule.forRecord(${c.R})`,
    test: (c) => `
  it('merge: a record lists its likely duplicates', async () => {
    const item = await create();
    const duplicates = await call('GET', \`${c.url}/\${item.id}/duplicates\`, ${c.writer});
    expect(duplicates.statusCode, duplicates.body).toBe(200);
    expect(duplicates.json().items).toBeInstanceOf(Array);
  });`,
  },
  'data-transfer': {
    about: 'exports to and imports from CSV or Excel',
    imports: mod('data-transfer', 'DataTransferModule'),
    call: (c) => `DataTransferModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'StorageModule'],
    env: { APP_ROLE: 'all', STORAGE_DRIVER: 'memory', ...ENCRYPTION },
    test: (c) => `
  it('data transfer: gives the file to fill for an import', async () => {
    const template = await call('GET', '/v1/data/imports/${c.t.plural}/template', ${c.writer});
    expect(template.statusCode, template.body).toBe(200);
  });`,
  },
  'data-quality': {
    about: 'scans for missing values, duplicates and broken rules',
    imports: mod('data-quality', 'DataQualityModule'),
    call: (c) => {
      const recommended = c.fields
        .filter((f) => f.optional && ['string', 'text'].includes(f.type))
        .map((f) => `'${f.name}'`);
      return recommended.length
        ? `DataQualityModule.forRecord(${c.R}, { recommended: [${recommended.join(', ')}] })`
        : `DataQualityModule.forRecord(${c.R})`;
    },
    comment:
      'Business logic: its checks (recommended, duplicates, rules: modules/data-quality/README.md).',
    boot: ['QueuesModule'],
    env: { APP_ROLE: 'all' },
    test: (c) => `
  it('data quality: a record has its findings', async () => {
    const item = await create();
    const findings = await call('GET', \`${c.url}/\${item.id}/data-quality\`, team.admin.headers);
    expect(findings.statusCode, findings.body).toBe(200);
  });`,
  },
  shares: {
    about: 'read-only links to one record',
    imports: mod('shares', 'SharesModule'),
    call: (c) => `SharesModule.forRecord(${c.R})`,
    boot: ['QueuesModule'],
    env: { ...WORKERS, WEB_URL: 'https://web.example.com' },
    test: (c) => `
  it('shares: a link to a record is made', async () => {
    const item = await create();
    const share = await call('POST', \`${c.url}/\${item.id}/shares\`, ${c.writer}, { fields: ['${c.fields[0].name}'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(share.statusCode, share.body).toBe(201);
  });`,
  },
  documents: {
    about: "a record's PDF, from templates/<item>.html",
    imports: { ...mod('documents', 'DocumentsModule'), join: 'node:path' },
    call: (c) =>
      `DocumentsModule.forRecord(${c.R}, { template: '${c.t.singular}', dir: join(import.meta.dirname, 'templates') })`,
    boot: [
      'QueuesModule',
      'MetricsModule',
      'SharedHttpClientModule',
      'StorageModule',
    ],
    env: { ...WORKERS, STORAGE_DRIVER: 'memory' },
    test: (c) => `
  it('documents: a record lists its PDFs', async () => {
    const item = await create();
    const documents = await call('GET', \`${c.url}/\${item.id}/documents\`, ${c.writer});
    expect(documents.statusCode, documents.body).toBe(200);
  });`,
  },
  ai: {
    about: 'summarize or classify a record with a language model',
    imports: mod('ai', 'AiModule'),
    call: (c) => `AiModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'MetricsModule'],
    test: (c) => `
  it('ai: a run is refused while no model is set up (ANTHROPIC_API_KEY)', async () => {
    const item = await create();
    const run = await call('POST', '/v1/ai/runs', ${c.writer}, { source: '${c.t.plural}', recordId: item.id, task: 'summarize' });
    expect(run.statusCode, run.body).toBe(503);
  });`,
  },
  automations: {
    about: "tenants' rules on a record's changes",
    imports: mod('automations', 'AutomationsModule'),
    call: (c) => `AutomationsModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'WebhooksModule', 'AutomationsModule'],
    env: { ...WORKERS, WEBHOOKS_WORKER: 'off', WEBHOOKS_ALLOW_LOOPBACK: 'on' },
    test: (c) => `
  it('automations: the record takes rules', async () => {
    const list = await call('GET', '/v1/lists/${c.t.Singular}', ${c.writer});
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().capabilities).toMatchObject({ automations: true });
  });`,
  },
  sequences: {
    about: 'a human-readable number on each record',
    imports: {
      ...mod('sequences', 'SequencesModule'),
      NUMBER_BODY: 'modules/sequences/sequences.record.js',
      NUMBER_RESPONSE: 'modules/sequences/sequences.record.js',
    },
    call: (c) => `SequencesModule.forRecord(${c.R})`,
    body: ['NUMBER_BODY'],
    response: ['NUMBER_RESPONSE'],
    columns: { numberColumns: 'modules/sequences/sequences.record.js' },
    test: () => `
  it('sequences: a new record has its number', async () => {
    const item = await create();
    expect(item.number).toMatch(/\\d{5}$/);
  });`,
  },
  webhooks: {
    about: "a record's changes as webhooks for API clients",
    imports: mod('webhooks', 'WebhooksModule'),
    call: (c) => `WebhooksModule.forRecord(${c.R})`,
    boot: ['WebhooksModule'],
    env: {
      WEBHOOKS_WORKER: 'off',
      WEBHOOKS_ALLOW_LOOPBACK: 'on',
      ...ENCRYPTION,
    },
    test: (c) => `
  it('webhooks: its changes are event types', async () => {
    const types = await call('GET', '/v1/webhook-event-types', ${c.writer});
    expect(types.statusCode, types.body).toBe(200);
    expect(types.body).toContain('${c.t.singularCamel}.created');
  });`,
  },
  notifications: {
    about: 'watching a record, and its watchers told of changes',
    imports: mod('notifications', 'NotificationsModule'),
    call: (c) => `NotificationsModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'NotificationsModule'],
    env: WORKERS,
    test: (c) => `
  it('notifications: a record is watched', async () => {
    const item = await create();
    const watched = await call('POST', \`${c.url}/\${item.id}/watch\`, ${c.writer});
    expect(watched.statusCode, watched.body).toBeLessThan(300);
  });`,
  },
  recurrence: {
    about: 'records created on a schedule',
    imports: mod('recurrence', 'RecurrenceModule'),
    call: (c) => `RecurrenceModule.forRecord(${c.R})`,
    boot: ['QueuesModule', 'RecurrenceModule'],
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
  },
  retention: {
    about: 'records purged after the days a tenant sets',
    imports: mod('retention', 'RetentionModule'),
    call: (c) =>
      `RetentionModule.forRecord(${c.R}, ${c.T}, { defaultDays: 730, minDays: 30 })`,
    comment:
      'Business logic: how long its records are kept by default (off until a tenant turns the rule on).',
    tableImport: true,
    boot: ['QueuesModule', 'HoldsModule', 'RetentionModule'],
    env: { APP_ROLE: 'all' },
    test: (c) => `
  it('retention: the record has a rule', async () => {
    const rules = await call('GET', '/v1/retention/rules', team.admin.headers);
    expect(rules.statusCode, rules.body).toBe(200);
    expect(rules.body).toContain('"${c.t.plural}"');
  });`,
  },
  mcp: {
    about: 'tools for AI agents (MCP): list, get, create, update, delete',
    imports: mod('mcp', 'McpModule'),
    call: (c) => `McpModule.forRecord(${c.R})`,
    boot: ['McpModule'],
    test: (c) => `
  it('mcp: its record tools are listed', async () => {
    const listed = await call('POST', '/v1/mcp', { ...${c.writer}, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain('"${c.url.slice(4)}_create"');
  });`,
  },
};

/** `--addons tags,comments` (or `all`): the add-ons, checked, in ADDONS order. */
export function parseAddons(list) {
  const raw = Array.isArray(list) ? list : String(list ?? '').split(',');
  const wanted = raw.map((name) => String(name).trim()).filter(Boolean);
  if (wanted.includes('all')) return Object.keys(ADDONS);
  for (const name of wanted) {
    if (!ADDONS[name]) {
      throw new Error(
        `--addons: "${name}" is not an add-on; any of ${Object.keys(ADDONS).join(', ')}, or all.`,
      );
    }
  }
  return Object.keys(ADDONS).filter((name) => wanted.includes(name));
}

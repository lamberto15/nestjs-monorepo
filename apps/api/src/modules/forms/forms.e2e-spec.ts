import { randomInt, randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { SharedIdempotencyModule } from '../../core/idempotency/idempotency.module.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { apiClientRoles } from '../../iam/access/access.tables.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { CaptchaModule } from '../../iam/captcha/captcha.module.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { PersonalDataService } from '../../iam/personal-data/personal-data.service.js';
import { ChoicesRegistry } from '../choices/choices.registry.js';
import { FormsModule } from './forms.module.js';
import { formPublicLinks } from './forms.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-forms-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: Buffer.alloc(32, 7).toString('base64'),
    // Public submissions ask for a challenge; the stub judges by the token.
    CAPTCHA_MODE: 'always',
    CAPTCHA_PROVIDER: 'stub',
  });
});

type Headers = Record<string, string>;
type Team = Awaited<ReturnType<typeof tenantWithAdmin>>;

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

/** An address of its own (trusted proxy: X-Forwarded-For), so per-address limits don't add up across tests. */
const address = () =>
  `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('forms (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      SecretsModule,
      SharedIdempotencyModule,
      ...accessModules(),
      MetricsModule,
      QueuesModule,
      CaptchaModule,
      PersonalDataModule,
      FormsModule,
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  /** Who sees the `secret` color: a provider of trusted code that filters by who asks. */
  const insiders = new Set<string>();
  beforeAll(() => {
    const registry = app.get(ChoicesRegistry);
    registry.provider({
      key: 'e2e-colors',
      label: 'Colors',
      params: {},
      mayUse: async (principal) => principal.kind === 'user',
      options: async ({ principal, q, limit }) =>
        ['blue', 'red', ...(insiders.has(principal.id) ? ['secret'] : [])]
          .filter((value) => !q || value.includes(q))
          .slice(0, limit)
          .map((value) => ({ value, label: value.toUpperCase() })),
      has: async ({ principal, value }) =>
        ['blue', 'red'].includes(value) ||
        (value === 'secret' && insiders.has(principal.id)),
    });
    registry.provider({
      key: 'e2e-slow',
      label: 'Slow',
      params: {},
      mayUse: async () => true,
      options: () => new Promise(() => {}),
      has: () => new Promise(() => {}),
    });
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers = {},
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  const definition = {
    sections: [
      {
        key: 'contact',
        title: 'Contact',
        fields: [
          { key: 'full_name', type: 'text', label: 'Name', required: true },
          {
            key: 'topic',
            type: 'select',
            label: 'Topic',
            options: [
              { value: 'billing', label: 'Billing' },
              { value: 'other', label: 'Something else' },
            ],
          },
          {
            key: 'seats',
            type: 'integer',
            label: 'Seats',
            validation: { min: 1, max: 10 },
          },
        ],
      },
    ],
  };

  /** A tenant with forms turned on. */
  async function team() {
    const made = await tenantWithAdmin(app);
    await setEnabled(made, true);
    return made;
  }

  async function setEnabled(made: Team, value: boolean) {
    const res = await call(
      'PUT',
      '/v1/settings/forms.enabled',
      made.admin.headers,
      { value },
    );
    expect(res.statusCode, res.body).toBe(200);
  }

  /** A member holding a role of these Form actions. */
  async function holder(made: Team, ...actions: string[]) {
    return member(app, made.tenantId, [await role(made, ...actions)]);
  }

  async function role(made: Team, ...actions: string[]) {
    const created = await call('POST', '/v1/access/roles', made.admin.headers, {
      name: `forms-${randomUUID().slice(0, 8)}`,
      permissions: actions.map((action) => ({
        subject: 'Form',
        action,
        conditions: [],
      })),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }

  /** A published form of `definition`: its id and published version id. */
  async function published(made: Team, body: object = { definition }) {
    const created = await call('POST', '/v1/forms', made.admin.headers, {
      slug: `intake-${randomUUID().slice(0, 8)}`,
      name: 'Intake',
      ...body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const version = await call(
      'POST',
      `/v1/forms/${id}/publish`,
      made.admin.headers,
      { revision: created.json().revision },
    );
    expect(version.statusCode, version.body).toBe(201);
    return { id, versionId: version.json().id as string };
  }

  const submit = (
    headers: Headers,
    formId: string,
    body: object,
    key = randomUUID(),
  ) =>
    call(
      'POST',
      `/v1/forms/${formId}/submissions`,
      { ...headers, 'idempotency-key': key },
      body,
    );

  const draft = (made: Team, id: string, body: object) =>
    call('PUT', `/v1/forms/${id}/draft`, made.admin.headers, body);

  it('answers 404 until the tenant turns forms on', async () => {
    const made = await tenantWithAdmin(app);
    expect(
      (await call('GET', '/v1/forms', made.admin.headers)).statusCode,
    ).toBe(404);
    await setEnabled(made, true);
    const listed = await call('GET', '/v1/forms', made.admin.headers);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
  });

  it('edits a draft under its revision, publishes immutable versions and keeps a published key’s type', async () => {
    const made = await team();
    const admin = made.admin.headers;
    const created = await call('POST', '/v1/forms', admin, {
      slug: 'incident-report',
      name: 'Incident report',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({
      status: 'active',
      publishedVersion: null,
    });
    const taken = await call('POST', '/v1/forms', admin, {
      slug: 'incident-report',
      name: 'Again',
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('form_slug_taken');
    const empty = await call('POST', `/v1/forms/${id}/publish`, admin, {
      revision: created.json().revision,
    });
    expect(empty.statusCode).toBe(400);
    expect(paths(empty.json())).toContain('definition.sections');

    const saved = await draft(made, id, {
      revision: created.json().revision,
      definition,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // An editor working from the old revision is refused, not overwritten.
    const stale = await draft(made, id, {
      revision: created.json().revision,
      definition,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('form_conflict');
    // A definition that breaks its own rules: the path says where.
    const invalid = await draft(made, id, {
      revision: saved.json().revision,
      definition: {
        sections: [
          {
            key: 'contact',
            fields: [
              { key: 'full_name', type: 'text', label: '<b>Name</b>' },
              { key: 'pick', type: 'select', label: 'Pick' },
            ],
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(paths(invalid.json()).length).toBeGreaterThan(0);

    const first = await call('POST', `/v1/forms/${id}/publish`, admin, {
      revision: saved.json().revision,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ version: 1 });
    const again = await call('POST', `/v1/forms/${id}/publish`, admin, {
      revision: saved.json().revision,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('form_unchanged');

    // Once published, `seats` stays an integer: a draft that retypes it is refused.
    const refused = await draft(made, id, {
      revision: saved.json().revision,
      definition: {
        sections: [
          {
            ...definition.sections[0],
            fields: [
              definition.sections[0]!.fields[0],
              { key: 'seats', type: 'text', label: 'Seats' },
            ],
          },
        ],
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(paths(refused.json())).toEqual([
      'definition.sections.0.fields.1.type',
    ]);

    // Version 1 is as it was published; the list says so.
    const v1 = await call('GET', `/v1/forms/${id}/versions/1`, admin);
    expect(v1.json().definition.sections[0].fields).toHaveLength(3);
    const versions = await call('GET', `/v1/forms/${id}/versions`, admin);
    expect(versions.json().items).toMatchObject([
      { version: 1, fieldCount: 3 },
    ]);
    // A published form isn't deleted: it is archived.
    const deleted = await call('DELETE', `/v1/forms/${id}`, admin);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe('form_published');
    // Audited, without the definition.
    const actions = (
      await app
        .get(Tenancy)
        .run(made.tenantId, () =>
          app
            .get<Database>(getDrizzleToken())
            .select({ action: auditLog.action })
            .from(auditLog)
            .where(eq(auditLog.targetId, id)),
        )
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'form.created',
        'form.draft-saved',
        'form.published',
      ]),
    );
  });

  it('takes answers checked against the exact published version, once per Idempotency-Key', async () => {
    const made = await team();
    const { id, versionId } = await published(made);
    const filler = await holder(made, 'read', 'submit');

    const shown = await call(
      'GET',
      `/v1/forms/${id}/published`,
      filler.headers,
    );
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toMatchObject({ versionId, version: 1 });

    const wrong = await submit(filler.headers, id, {
      versionId,
      answers: { topic: 'nope', seats: 11, extra: 'x' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(paths(wrong.json())).toEqual(
      expect.arrayContaining([
        'answers.full_name',
        'answers.topic',
        'answers.seats',
        'answers.extra',
      ]),
    );
    // Without a key: refused, so a retry can never answer twice.
    const keyless = await call(
      'POST',
      `/v1/forms/${id}/submissions`,
      filler.headers,
      { versionId, answers: { full_name: 'Ada' } },
    );
    expect(keyless.statusCode).toBe(400);

    const key = randomUUID();
    const body = {
      versionId,
      answers: { full_name: ' Ada ', topic: 'billing', seats: '2' },
    };
    const sent = await submit(filler.headers, id, body, key);
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({
      versionId,
      version: 1,
      answers: { full_name: 'Ada', topic: 'billing', seats: 2 },
    });
    const replayed = await submit(filler.headers, id, body, key);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json().id).toBe(sent.json().id);

    // A new version: answers to the old one are refused, the old submission still reads as v1.
    const current = await call(
      'GET',
      `/v1/forms/${id}/draft`,
      made.admin.headers,
    );
    const changed = await draft(made, id, {
      revision: current.json().revision,
      definition: {
        sections: [
          {
            ...definition.sections[0],
            fields: [
              ...definition.sections[0]!.fields,
              { key: 'notes', type: 'textarea', label: 'Notes' },
            ],
          },
        ],
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const v2 = await call(
      'POST',
      `/v1/forms/${id}/publish`,
      made.admin.headers,
      {
        revision: changed.json().revision,
      },
    );
    expect(v2.statusCode).toBe(201);
    const outdated = await submit(filler.headers, id, body);
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json()).toMatchObject({
      code: 'form_version_outdated',
      versionId: v2.json().id,
    });
    const kept = await call(
      'GET',
      `/v1/forms/${id}/submissions/${sent.json().id}`,
      filler.headers,
    );
    expect(kept.json()).toMatchObject({
      version: 1,
      answers: { full_name: 'Ada', seats: 2 },
    });
    // Archived: no answers, and hidden from submitters.
    await call('POST', `/v1/forms/${id}/archive`, made.admin.headers);
    const closed = await submit(filler.headers, id, {
      versionId: v2.json().id,
      answers: { full_name: 'Ada' },
    });
    expect(closed.statusCode).toBe(404);
  });

  it('validates conditions at save, and requires or strips answers by them on the server', async () => {
    const made = await team();
    const created = await call('POST', '/v1/forms', made.admin.headers, {
      slug: `rules-${randomUUID().slice(0, 8)}`,
      name: 'Rules',
      definition: { ...definition, format: 1 },
    });
    const id = created.json().id as string;
    const v1 = await call(
      'POST',
      `/v1/forms/${id}/publish`,
      made.admin.headers,
      {
        revision: created.json().revision,
      },
    );
    const filler = await holder(made, 'read', 'submit');
    const first = await submit(filler.headers, id, {
      versionId: v1.json().id,
      answers: { full_name: 'Ada' },
    });
    expect(first.statusCode, first.body).toBe(201);

    const other = { field: 'topic', op: 'eq', value: 'other' };
    const fields = [
      ...definition.sections[0]!.fields,
      {
        key: 'details',
        type: 'textarea',
        label: 'Details',
        visibleWhen: other,
        requiredWhen: other,
      },
    ];
    const refused = await draft(made, id, {
      revision: created.json().revision,
      definition: {
        sections: [
          {
            key: 'contact',
            fields: [
              { ...fields[0], visibleWhen: { field: 'topic', op: 'isEmpty' } },
              ...fields.slice(1, 3),
              { ...fields[3], visibleWhen: { ...other, value: 'nope' } },
            ],
          },
        ],
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(paths(refused.json())).toEqual([
      'definition.sections.0.fields.0.visibleWhen.field',
      'definition.sections.0.fields.3.visibleWhen.value',
    ]);
    const saved = await draft(made, id, {
      revision: created.json().revision,
      definition: { sections: [{ key: 'contact', fields }] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const v2 = await call(
      'POST',
      `/v1/forms/${id}/publish`,
      made.admin.headers,
      {
        revision: saved.json().revision,
      },
    );
    expect(v2.json().definition.format).toBe(4);

    const missing = await submit(filler.headers, id, {
      versionId: v2.json().id,
      answers: { full_name: 'Ada', topic: 'other' },
    });
    expect(paths(missing.json())).toEqual(['answers.details']);
    const stripped = await submit(filler.headers, id, {
      versionId: v2.json().id,
      answers: { full_name: 'Ada', topic: 'billing', details: 'sneaked' },
    });
    expect(stripped.statusCode).toBe(201);
    expect(stripped.json().answers).toEqual({
      full_name: 'Ada',
      topic: 'billing',
    });
    const oldVersion = await call(
      'GET',
      `/v1/forms/${id}/versions/1`,
      filler.headers,
    );
    expect(oldVersion.json().definition.format).toBe(1);
  });

  it('checks a repeatable group item by item on the server, its pages and bounds at save', async () => {
    const made = await team();
    const created = await call('POST', '/v1/forms', made.admin.headers, {
      slug: `steps-${randomUUID().slice(0, 8)}`,
      name: 'Steps',
    });
    const id = created.json().id as string;
    const people = {
      key: 'people',
      type: 'group',
      label: 'People',
      validation: { minItems: 1, maxItems: 2 },
      fields: [
        { key: 'who', type: 'text', label: 'Who', required: true },
        { key: 'age', type: 'integer', label: 'Age', validation: { max: 120 } },
      ],
    };
    const team_ = (field: object) => ({
      revision: created.json().revision,
      definition: {
        sections: [
          definition.sections[0],
          { key: 'team', startsPage: true, fields: [field] },
        ],
      },
    });
    const nested = await draft(
      made,
      id,
      team_({ ...people, fields: [{ ...people, key: 'inner' }] }),
    );
    expect(paths(nested.json())).toContain(
      'definition.sections.1.fields.0.fields.0.type',
    );
    const capped = await draft(
      made,
      id,
      team_({ ...people, validation: { maxItems: 51 } }),
    );
    expect(paths(capped.json())).toEqual([
      'definition.sections.1.fields.0.validation.maxItems',
    ]);
    const saved = await draft(made, id, team_(people));
    expect(saved.statusCode, saved.body).toBe(200);
    const v1 = await call(
      'POST',
      `/v1/forms/${id}/publish`,
      made.admin.headers,
      {
        revision: saved.json().revision,
      },
    );
    expect(v1.json().definition.sections[1].startsPage).toBe(true);

    const filler = await holder(made, 'read', 'submit');
    const wrong = await submit(filler.headers, id, {
      versionId: v1.json().id,
      answers: {
        full_name: 'Ada',
        people: [{ who: ' ' }, { who: 'Bo', age: 200, extra: 1 }],
      },
    });
    expect(paths(wrong.json())).toEqual([
      'answers.people.0.who',
      'answers.people.1.extra',
      'answers.people.1.age',
    ]);
    const tooMany = await submit(filler.headers, id, {
      versionId: v1.json().id,
      answers: {
        full_name: 'Ada',
        people: [{ who: 'a' }, { who: 'b' }, { who: 'c' }],
      },
    });
    expect(paths(tooMany.json())).toEqual(['answers.people']);
    const sent = await submit(filler.headers, id, {
      versionId: v1.json().id,
      answers: { full_name: 'Ada', people: [{ who: 'Bo', age: '4' }] },
    });
    expect(sent.json().answers).toEqual({
      full_name: 'Ada',
      people: [{ who: 'Bo', age: 4 }],
    });
  });

  it('takes choices from a registered source, checks each answer by it, and refuses others', async () => {
    const made = await team();
    const admin = made.admin.headers;
    insiders.add(made.admin.id);
    const unit = await call('POST', '/v1/access/organizational-units', admin, {
      type: 'team',
      name: `unit-${randomUUID().slice(0, 6)}`,
    });
    expect(unit.statusCode, unit.body).toBe(201);

    const sources = await call('GET', '/v1/forms/option-sources', admin);
    const keys = sources.json().items.map((item: { key: string }) => item.key);
    expect(keys).toEqual(
      expect.arrayContaining(['organizational-units', 'e2e-colors']),
    );
    // A source with parameters isn't offered.
    expect(keys).not.toContain('unit-members');

    const created = await call('POST', '/v1/forms', admin, {
      slug: `sources-${randomUUID().slice(0, 8)}`,
      name: 'Sources',
    });
    const id = created.json().id as string;
    // A link made before a sourced version is published stops opening then.
    const early = await call('POST', `/v1/forms/${id}/public-links`, admin, {});
    const choice = (key: string, provider: string, type = 'select') => ({
      key,
      type,
      label: key,
      optionsSource: { provider },
    });
    // Unregistered, or taking parameters: refused at save.
    const refused = await draft(made, id, {
      revision: created.json().revision,
      definition: {
        sections: [
          {
            key: 'main',
            fields: [choice('a', 'https-evil'), choice('b', 'unit-members')],
          },
        ],
      },
    });
    expect(paths(refused.json())).toEqual([
      'definition.sections.0.fields.0.optionsSource.provider',
      'definition.sections.0.fields.1.optionsSource.provider',
    ]);
    const saved = await draft(made, id, {
      revision: created.json().revision,
      definition: {
        sections: [
          {
            key: 'main',
            fields: [
              { ...choice('unit', 'organizational-units'), required: true },
              choice('colors', 'e2e-colors', 'multiSelect'),
              choice('slow', 'e2e-slow'),
            ],
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const version = await call('POST', `/v1/forms/${id}/publish`, admin, {
      revision: saved.json().revision,
    });
    expect(version.json().definition.format).toBe(4);
    const versionId = version.json().id as string;

    const filler = await holder(made, 'read', 'submit');
    // The choices through the form, filtered to the filler, bounded.
    const colors = await call(
      'GET',
      `/v1/forms/${id}/options/colors?limit=1`,
      filler.headers,
    );
    expect(colors.json()).toEqual({
      field: 'colors',
      items: [{ value: 'blue', label: 'BLUE' }],
      hasMore: true,
    });
    const narrowed = await call(
      'GET',
      `/v1/forms/${id}/options/colors?q=re`,
      filler.headers,
    );
    expect(narrowed.json().items).toEqual([{ value: 'red', label: 'RED' }]);
    const unitsSeen = await call(
      'GET',
      `/v1/forms/${id}/options/unit`,
      filler.headers,
    );
    expect(unitsSeen.json().items).toContainEqual({
      value: unit.json().id,
      label: unit.json().name,
    });
    // Only a field's own source, never one by name; a limit over 50 is refused.
    expect(
      (await call('GET', `/v1/forms/${id}/options/nope`, filler.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'GET',
          `/v1/forms/${id}/options/colors?limit=51`,
          filler.headers,
        )
      ).statusCode,
    ).toBe(400);
    // A slow source: a 503, not a hang.
    const slow = await call(
      'GET',
      `/v1/forms/${id}/options/slow`,
      filler.headers,
    );
    expect(slow.statusCode).toBe(503);
    expect(slow.json().code).toBe('form_source_unavailable');

    // Values checked by the source, never a label; another's choice refused.
    const wrong = await submit(filler.headers, id, {
      versionId,
      answers: { unit: randomUUID(), colors: ['BLUE', 'secret'] },
    });
    expect(paths(wrong.json())).toEqual([
      'answers.unit',
      'answers.colors.0',
      'answers.colors.1',
    ]);
    const sent = await submit(filler.headers, id, {
      versionId,
      answers: { unit: unit.json().id, colors: ['red'] },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().answers).toEqual({
      unit: unit.json().id,
      colors: ['red'],
    });

    // Another tenant's unit is no choice here (row-level security).
    const other = await team();
    const theirs = await call(
      'POST',
      '/v1/access/organizational-units',
      other.admin.headers,
      { type: 'team', name: 'theirs' },
    );
    const foreign = await submit(filler.headers, id, {
      versionId,
      answers: { unit: theirs.json().id },
    });
    expect(paths(foreign.json())).toEqual(['answers.unit']);

    // A client may submit forms, not use a source made for users: 403.
    const client = await apiClient(app, made.tenantId);
    const submitter = await role(made, 'read', 'submit');
    await app
      .get(Tenancy)
      .run(made.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .insert(apiClientRoles)
          .values({ clientId: client.client.id, roleId: submitter }),
      );
    const denied = await call(
      'GET',
      `/v1/forms/${id}/options/unit`,
      client.headers,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('form_source_forbidden');

    // Never public: no new link, and the earlier one no longer opens.
    const link = await call('POST', `/v1/forms/${id}/public-links`, admin, {});
    expect(link.statusCode).toBe(400);
    expect(link.json().code).toBe('form_link_sources');
    const opened = await call(
      'POST',
      '/v1/public/forms/open',
      { 'x-forwarded-for': address() },
      { token: early.json().token },
    );
    expect(opened.statusCode).toBe(404);
  });

  it('opens a form to anyone holding a public link, until it is revoked, expires, is used up or closed', async () => {
    const made = await team();
    const admin = made.admin.headers;
    const created = await call('POST', '/v1/forms', admin, {
      slug: `public-${randomUUID().slice(0, 8)}`,
      name: 'Public',
      description: 'Tell us',
      definition,
    });
    const id = created.json().id as string;
    const link = async (body: object = {}) => {
      const res = await call(
        'POST',
        `/v1/forms/${id}/public-links`,
        admin,
        body,
      );
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string; token: string; url: string };
    };
    const first = await link({ maxSubmissions: 1 });
    expect(first.url).toMatch(/\/public-form#frm_/);
    const open = (token: string) =>
      call(
        'POST',
        '/v1/public/forms/open',
        { 'x-forwarded-for': address() },
        {
          token,
        },
      );
    const send = (
      token: string,
      versionId: string,
      answers: object,
      captcha: string | null = `stub:pass:${randomUUID()}`,
    ) =>
      call(
        'POST',
        '/v1/public/forms/submit',
        {
          'x-forwarded-for': address(),
          ...(captcha && { 'x-captcha-token': captcha }),
        },
        { token, versionId, answers },
      );

    // Not published yet: the same 404 as a forged link.
    const unpublished = await open(first.token);
    expect(unpublished.statusCode).toBe(404);
    expect(unpublished.json().code).toBe('form_link_not_found');
    const version = await call('POST', `/v1/forms/${id}/publish`, admin, {
      revision: created.json().revision,
    });
    const versionId = version.json().id as string;
    const opened = await open(first.token);
    expect(opened.statusCode, opened.body).toBe(200);
    // The published version and nothing else: no form id, slug or tenant.
    expect(Object.keys(opened.json()).sort()).toEqual(
      ['definition', 'description', 'name', 'version', 'versionId'].sort(),
    );
    expect(opened.json()).toMatchObject({ versionId, description: 'Tell us' });

    // Bot protection: no challenge, or a failed one, never reaches the form.
    const noChallenge = await send(
      first.token,
      versionId,
      { full_name: 'Eve' },
      null,
    );
    expect(noChallenge.statusCode).toBe(403);
    expect(noChallenge.json().code).toBe('captcha_required');
    const failed = await send(
      first.token,
      versionId,
      { full_name: 'Eve' },
      'stub:fail',
    );
    expect(failed.statusCode).toBe(403);
    // Checked as any submission.
    const invalid = await send(first.token, versionId, { seats: 2 });
    expect(invalid.statusCode).toBe(400);
    expect(paths(invalid.json())).toEqual(['answers.full_name']);
    const sent = await send(first.token, versionId, { full_name: 'Eve' });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(Object.keys(sent.json()).sort()).toEqual([
      'createdAt',
      'id',
      'version',
    ]);
    const stored = await call(
      'GET',
      `/v1/forms/${id}/submissions/${sent.json().id}`,
      admin,
    );
    expect(stored.json()).toMatchObject({
      submittedBy: `public:${first.id}`,
      answers: { full_name: 'Eve' },
    });
    // Audited as nobody, without the answers.
    const [entry] = await app.get(Tenancy).run(made.tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'form.submitted'),
            eq(auditLog.targetId, sent.json().id),
          ),
        ),
    );
    expect(entry).toMatchObject({ actor: 'anonymous' });
    expect(JSON.stringify(entry!.details)).not.toContain('Eve');
    // Its quota of one is used up.
    expect(
      (await send(first.token, versionId, { full_name: 'Again' })).statusCode,
    ).toBe(404);
    expect((await open(first.token)).statusCode).toBe(404);

    // Revoked, expired, forged, another tenant's: all the one 404.
    const second = await link();
    expect((await open(second.token)).statusCode).toBe(200);
    const revoked = await call(
      'POST',
      `/v1/forms/${id}/public-links/${second.id}/revoke`,
      admin,
    );
    expect(revoked.statusCode).toBe(200);
    expect((await open(second.token)).statusCode).toBe(404);
    const third = await link();
    await app.get(Tenancy).run(made.tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .update(formPublicLinks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(formPublicLinks.id, third.id)),
    );
    expect((await open(third.token)).statusCode).toBe(404);
    expect((await open(`${second.token.slice(0, -4)}AAAA`)).statusCode).toBe(
      404,
    );
    expect((await open('frm_nope')).statusCode).toBe(404);
    const other = await team();
    const forged = third.token.replace(/^frm_[^_]+_/, `frm_${other.tenantId}_`);
    expect((await open(forged)).statusCode).toBe(404);

    // Archived, or forms turned off: closed too, the link kept.
    const fourth = await link();
    await call('POST', `/v1/forms/${id}/archive`, admin);
    expect((await open(fourth.token)).statusCode).toBe(404);
    await call('POST', `/v1/forms/${id}/unarchive`, admin);
    expect((await open(fourth.token)).statusCode).toBe(200);
    await setEnabled(made, false);
    expect((await open(fourth.token)).statusCode).toBe(404);
    await setEnabled(made, true);

    // The link opens this form alone: nothing else of it, nor of the tenant.
    expect((await call('GET', `/v1/forms/${id}/published`)).statusCode).toBe(
      401,
    );
    expect((await call('GET', `/v1/forms/${id}/submissions`)).statusCode).toBe(
      401,
    );
    const list = await call('GET', `/v1/forms/${id}/public-links`, admin);
    expect(list.json().items).toHaveLength(4);
    expect(list.json().items[0]).not.toHaveProperty('token');
    expect(
      list.json().items.find((item: { id: string }) => item.id === first.id),
    ).toMatchObject({ submissions: 1, maxSubmissions: 1 });
  });

  it('limits public requests per address', async () => {
    const made = await team();
    const { id } = await published(made);
    const created = await call(
      'POST',
      `/v1/forms/${id}/public-links`,
      made.admin.headers,
      {},
    );
    const from = address();
    const statuses: number[] = [];
    for (let n = 0; n < 11; n++) {
      const res = await call(
        'POST',
        '/v1/public/forms/submit',
        {
          'x-forwarded-for': from,
          'x-captcha-token': `stub:pass:${randomUUID()}`,
        },
        {
          token: created.json().token,
          versionId: randomUUID(),
          answers: {},
        },
      );
      statuses.push(res.statusCode);
    }
    // Ten in ten minutes from one address, then 429.
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it('makes public links only for members who edit, within bounds', async () => {
    const made = await team();
    const admin = made.admin.headers;
    const { id } = await published(made);
    const make = (headers: Headers, body: object = {}) =>
      call('POST', `/v1/forms/${id}/public-links`, headers, body);
    expect(
      (
        await make(admin, {
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await make(admin, {
          expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    for (let n = 0; n < 5; n++) {
      expect((await make(admin)).statusCode).toBe(201);
    }
    expect((await make(admin)).statusCode).toBe(400);
    const filler = await holder(made, 'read', 'submit');
    expect((await make(filler.headers)).statusCode).toBe(403);
    expect(
      (await call('GET', `/v1/forms/${id}/public-links`, filler.headers))
        .statusCode,
    ).toBe(403);
    // An API client may edit forms, never open one to the public.
    const editor = await role(made, 'edit');
    const client = await apiClient(app, made.tenantId);
    await app
      .get(Tenancy)
      .run(made.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .insert(apiClientRoles)
          .values({ clientId: client.client.id, roleId: editor }),
      );
    expect(
      (await call('GET', `/v1/forms/${id}/draft`, client.headers)).statusCode,
    ).toBe(200);
    expect((await make(client.headers)).statusCode).toBe(403);
  });

  it('shows a submitter their own submissions, everyone’s only to those who read responses', async () => {
    const made = await team();
    const { id, versionId } = await published(made);
    const submitter = await role(made, 'read', 'submit');
    const ada = await member(app, made.tenantId, [submitter]);
    const bob = await member(app, made.tenantId, [submitter]);
    const reviewer = await holder(made, 'read', 'readResponses');
    const reader = await holder(made, 'read');

    const mine = await submit(ada.headers, id, {
      versionId,
      answers: { full_name: 'Ada' },
    });
    expect(mine.statusCode, mine.body).toBe(201);
    await submit(bob.headers, id, { versionId, answers: { full_name: 'Bob' } });

    const own = await call('GET', `/v1/forms/${id}/submissions`, ada.headers);
    expect(own.json().items.map((s: { id: string }) => s.id)).toEqual([
      mine.json().id,
    ]);
    expect(
      (
        await call(
          'GET',
          `/v1/forms/${id}/submissions/${mine.json().id}`,
          bob.headers,
        )
      ).statusCode,
    ).toBe(404);
    const all = await call(
      'GET',
      `/v1/forms/${id}/submissions`,
      reviewer.headers,
    );
    expect(all.json().items).toHaveLength(2);
    // Reading forms is not reading answers, nor submitting, nor editing.
    expect(
      (await call('GET', `/v1/forms/${id}/submissions`, reader.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await submit(reader.headers, id, {
          versionId,
          answers: { full_name: 'R' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', '/v1/forms', reviewer.headers, {
          slug: 'nope',
          name: 'Nope',
        })
      ).statusCode,
    ).toBe(403);
    // A reader sees published forms only, without the draft state.
    const listed = await call('GET', '/v1/forms', reader.headers);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).not.toHaveProperty('hasDraftChanges');
    // The audit says who submitted, never what.
    const [entry] = await app.get(Tenancy).run(made.tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'form.submitted'),
            eq(auditLog.targetId, mine.json().id),
          ),
        ),
    );
    expect(entry).toMatchObject({ actor: `user:${ada.id}` });
    expect(JSON.stringify(entry!.details)).not.toContain('Ada');
    // A person's submissions are in their data export.
    const sections: string[] = [];
    await app.get(PersonalDataService).export(ada.id, async (batch) => {
      if (batch.section === 'form-submissions') {
        sections.push(...batch.rows.map((row) => row.id as string));
      }
    });
    expect(sections).toEqual([mine.json().id]);
  });

  it('keeps another tenant’s forms and answers out of reach, even by id', async () => {
    const made = await team();
    const { id, versionId } = await published(made);
    const other = await team();
    const theirs = other.admin.headers;
    expect((await call('GET', `/v1/forms/${id}`, theirs)).statusCode).toBe(404);
    expect(
      (await call('GET', `/v1/forms/${id}/published`, theirs)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/forms/${id}/submissions`, theirs)).statusCode,
    ).toBe(404);
    expect(
      (await submit(theirs, id, { versionId, answers: { full_name: 'Eve' } }))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', '/v1/forms', theirs)).json().items).toEqual([]);
  });
});

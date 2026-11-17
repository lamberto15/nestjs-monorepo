import { z } from 'zod';
import { tenantItems } from '../../../test/fixtures/tenant-items.tables.js';
import type { Principal } from '../auth/principal.js';
import { PermissionCatalog, subjectTextKey } from './permission-catalog.js';
import { ALL, createdBy, definePermissions, NO_UNITS } from './permissions.js';

const NOTES = definePermissions({
  subjects: {
    Note: {
      actions: { read: ['mine', 'named'], update: ['mine'] },
      conditions: {
        mine: createdBy(tenantItems.name),
        named: {
          params: z.object({ name: z.string().min(1) }),
          where: (_principal, params: { name: string }) => [
            [tenantItems.name, params.name],
          ],
        },
      },
      fields: { body: {}, secret: { sensitive: true } },
    },
  },
  seedRoles: [
    {
      key: 'editor',
      permissions: [{ subject: 'Note', action: 'read', conditions: [] }],
    },
  ],
  systemJobs: [
    {
      key: 'note-cleanup',
      permissions: [{ subject: 'Note', action: 'update', conditions: [] }],
    },
  ],
});

const user = { kind: 'user', id: 'u1' } as Principal;

describe('PermissionCatalog', () => {
  it('merges the subjects, seed roles and jobs of every declaration', () => {
    const catalog = PermissionCatalog.of(
      NOTES,
      definePermissions({
        subjects: { Note: { actions: { archive: [] } } },
        seedRoles: [
          {
            key: 'editor',
            permissions: [
              { subject: 'Note', action: 'archive', conditions: [] },
            ],
          },
        ],
      }),
    );
    expect(Object.keys(catalog.subjects.Note!.actions)).toEqual([
      'read',
      'update',
      'archive',
    ]);
    expect(catalog.seedRoles).toEqual([
      {
        key: 'editor',
        permissions: [
          { subject: 'Note', action: 'read', conditions: [], fields: null },
          { subject: 'Note', action: 'archive', conditions: [], fields: null },
        ],
      },
    ]);
    expect(catalog.systemJob('note-cleanup')?.permissions).toHaveLength(1);
    expect(catalog.declaredFields('Note')).toEqual(['body', 'secret']);
    expect(catalog.sensitiveFields('Note')).toEqual(['secret']);
  });

  it.each([
    [
      'an action declared twice',
      [
        NOTES,
        definePermissions({ subjects: { Note: { actions: { read: [] } } } }),
      ],
      /declared twice/,
    ],
    [
      'the subject "all"',
      [definePermissions({ subjects: { all: { actions: { read: [] } } } })],
      /CASL/,
    ],
    [
      'an action "manage"',
      [definePermissions({ subjects: { Thing: { actions: { manage: [] } } } })],
      /every action/,
    ],
    [
      'an undeclared condition',
      [
        definePermissions({
          subjects: { Thing: { actions: { read: ['nope'] } } },
        }),
      ],
      /undeclared conditions: nope/,
    ],
    [
      'a seed role permission not declared',
      [
        definePermissions({
          seedRoles: [
            {
              key: 'x',
              permissions: [
                { subject: 'Nope', action: 'read', conditions: [] },
              ],
            },
          ],
        }),
      ],
      /Unknown subject/,
    ],
    [
      'a job key out of form',
      [
        definePermissions({
          systemJobs: [{ key: 'Bad Key', permissions: [] }],
        }),
      ],
      /lowercase/,
    ],
    [
      'a job declared twice',
      [
        definePermissions({
          systemJobs: [
            { key: 'a', permissions: [] },
            { key: 'a', permissions: [] },
          ],
        }),
      ],
      /twice/,
    ],
    [
      'a job holding everything',
      [definePermissions({ systemJobs: [{ key: 'a', permissions: [ALL] }] })],
      /all\.manage/,
    ],
  ])('refuses %s at startup', (_name, definitions, error) => {
    expect(() => PermissionCatalog.of(...definitions)).toThrow(error);
  });

  it('validates a permission: subject, action, conditions and their params, fields', () => {
    const catalog = PermissionCatalog.of(NOTES);
    const check = (input: object) =>
      catalog.validate({ conditions: [], ...input } as never);
    expect(check({ subject: 'Nope', action: 'read' })).toMatchObject({
      ok: false,
    });
    expect(check({ subject: 'Note', action: 'delete' })).toMatchObject({
      ok: false,
    });
    expect(
      check({
        subject: 'Note',
        action: 'update',
        conditions: [{ key: 'named' }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      check({
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'named', params: { name: '' } }],
      }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      check({ subject: 'Note', action: 'read', fields: ['nope'] }),
    ).toMatchObject({ ok: false });
    expect(
      check({
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'named', params: { name: 'a', extra: 1 } }],
        fields: ['body', 'body'],
      }),
    ).toEqual({
      ok: true,
      value: {
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'named', params: { name: 'a' } }],
        fields: ['body'],
      },
    });
  });

  it("derives a condition's comparisons, by the record's field names; an unknown one is null", () => {
    const catalog = PermissionCatalog.of(NOTES);
    expect(
      catalog.comparisons(
        user,
        { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
        NO_UNITS,
      ),
    ).toEqual([
      { field: 'name', column: tenantItems.name, values: ['user:u1'] },
    ]);
    expect(
      catalog.comparisons(
        user,
        { subject: 'Note', action: 'update', conditions: [{ key: 'named' }] },
        NO_UNITS,
      ),
    ).toBeNull();
  });

  it('names the texts of a subject in kebab case, and shows keys without i18n', () => {
    expect(subjectTextKey('MailSuppression')).toBe('mail-suppression');
    const view = PermissionCatalog.of(NOTES).view();
    expect(view[0]).toMatchObject({
      subject: 'Note',
      label: 'permissions.note.label',
      actions: [
        {
          action: 'read',
          conditions: [
            { key: 'mine', label: 'permissions.note.conditions.mine.label' },
            { key: 'named' },
          ],
        },
        { action: 'update' },
      ],
    });
  });
});

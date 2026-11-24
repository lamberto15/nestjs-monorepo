import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { tenantItems } from '../../../test/fixtures/tenant-items.tables.js';
import type { Principal } from '../auth/principal.js';
import {
  AccessService,
  abilityOf,
  caslCondition,
  sqlCondition,
} from './access.service.js';
import { regrant } from './members.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL, definePermissions, NO_UNITS } from './permissions.js';

const dialect = new PgDialect();
const render = (condition: ReturnType<typeof sqlCondition>) =>
  dialect.sqlToQuery(condition);
const name = (values: readonly string[]) => ({
  field: 'name',
  column: tenantItems.name,
  values,
});

describe('the two forms of a condition', () => {
  it('CASL: each field must hold one of its values; a field twice holds the values in both', () => {
    expect(caslCondition([name(['a', 'b']), name(['b', 'c'])])).toEqual({
      name: { $in: ['b'] },
    });
    expect(caslCondition([name([])])).toEqual({ name: { $in: [] } });
  });

  it('SQL: eq for one value, inArray for several, false for none, and all of them together', () => {
    expect(render(sqlCondition([name(['a'])])).sql).toBe(
      '"test_tenant_items"."name" = $1',
    );
    expect(render(sqlCondition([name(['a', 'b'])])).sql).toBe(
      '"test_tenant_items"."name" in ($1, $2)',
    );
    expect(render(sqlCondition([name([])])).sql).toBe('false');
    expect(render(sqlCondition([name(['a']), name(['b'])])).sql).toBe(
      '(("test_tenant_items"."name" = $1) and ("test_tenant_items"."name" = $2))',
    );
    expect(render(sqlCondition([])).sql).toBe(render(sql`true`).sql);
  });
});

describe('abilityOf', () => {
  const catalog = PermissionCatalog.of(
    definePermissions({
      subjects: {
        Note: { actions: { read: [], update: [] }, fields: { body: {} } },
      },
    }),
  );
  const user = { kind: 'user', id: 'u1' } as Principal;

  it('grants everything to all.manage, and fields: [] none of the declared fields', () => {
    expect(
      abilityOf(catalog, user, [ALL], NO_UNITS).can('update', 'Note'),
    ).toBe(true);
    const ability = abilityOf(
      catalog,
      user,
      [{ subject: 'Note', action: 'read', conditions: [], fields: [] }],
      NO_UNITS,
    );
    expect(ability.can('read', 'Note')).toBe(true);
    expect(ability.can('read', 'Note', 'body')).toBe(false);
    expect(ability.can('update', 'Note')).toBe(false);
  });
});

describe('regrant', () => {
  const later = new Date(Date.now() + 3_600_000);

  it('keeps an unchanged grant out of the roles to check, its end with it', () => {
    const current = new Map<string, Date | null>([
      ['a', null],
      ['b', later],
    ]);
    expect(regrant(current, ['a', 'b'])).toEqual({
      changed: [],
      expiries: { b: later.toISOString() },
    });
  });

  it('checks the roles given, taken away and whose end moves', () => {
    const current = new Map<string, Date | null>([
      ['a', null],
      ['b', later],
    ]);
    const moved = new Date(later.getTime() + 1000).toISOString();
    expect(regrant(current, ['b', 'c'], { b: moved }).changed.sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('refuses an end of a role not given, or one already past', () => {
    expect(() => regrant(new Map(), ['a'], { b: later.toISOString() })).toThrow(
      /isn't in roleIds/,
    );
    expect(() =>
      regrant(new Map(), ['a'], { a: new Date(0).toISOString() }),
    ).toThrow(/already have ended/);
  });
});

describe('the ability cache', () => {
  type Entry = { loaded: { version: number }; until: number };
  const service = () => {
    const access = new AccessService(
      ...([{}, {}, {}, {}, {}] as unknown as ConstructorParameters<
        typeof AccessService
      >),
    );
    const internals = access as unknown as {
      cache: Map<string, Entry>;
      version: number;
      makeRoom(): void;
    };
    return internals;
  };

  it('keeps at most MAX_ENTRIES: the expired go first, then the oldest', () => {
    const access = service();
    const live = Date.now() + 60_000;
    for (let i = 0; i < AccessService.MAX_ENTRIES; i++) {
      access.cache.set(`k${i}`, {
        loaded: { version: access.version },
        until: i === 5 ? 0 : live,
      });
    }
    access.makeRoom();
    expect(access.cache.size).toBe(AccessService.MAX_ENTRIES - 1);
    expect(access.cache.has('k5')).toBe(false);
    expect(access.cache.has('k0')).toBe(true);
    access.cache.set('k5', {
      loaded: { version: access.version },
      until: live,
    });
    access.makeRoom();
    expect(access.cache.size).toBe(AccessService.MAX_ENTRIES - 1);
    expect(access.cache.has('k0')).toBe(false);
  });
});

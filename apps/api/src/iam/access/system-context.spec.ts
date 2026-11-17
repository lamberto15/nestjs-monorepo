import { PermissionCatalog } from './permission-catalog.js';
import { defineSystemJob, definePermissions } from './permissions.js';
import { SystemContext } from './system-context.js';

const CLEANUP = defineSystemJob({ key: 'cleanup', permissions: [] });

describe('SystemContext', () => {
  const catalog = PermissionCatalog.of(
    definePermissions({ systemJobs: [CLEANUP] }),
  );
  const context = new SystemContext(
    {} as never,
    {} as never,
    catalog,
    {} as never,
  );

  it('makes the principal of a declared job: system:<key>, its label from the texts', () => {
    expect(context.principal(CLEANUP)).toMatchObject({
      kind: 'system',
      id: 'cleanup',
    });
    expect(context.principal('cleanup')).toMatchObject({
      kind: 'system',
      id: 'cleanup',
    });
  });

  it('refuses a job no declaration has', () => {
    expect(() => context.principal('undeclared')).toThrow(/isn't declared/);
  });
});

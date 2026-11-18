import type { TransactionHost } from '@nestjs-cls/transactional';
import { z } from 'zod';
import type { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import type { ConfigBundle } from './config-bundles.schemas.js';
import {
  BundleSections,
  type BundleSectionHandler,
} from './config-bundles.sections.js';
import {
  canonicalJson,
  checksumOf,
  ConfigBundlesService,
} from './config-bundles.service.js';

/** A section holding a list of names, in memory. */
function namesSection(initial: string[]) {
  const held = [...initial];
  const imported = vi.fn();
  const handler: BundleSectionHandler<string[]> = {
    schema: z.array(z.string().max(10)),
    export: async () => [...held].sort(),
    preview: async (names) => ({
      changes: names.map((ref) => ({
        ref,
        action: held.includes(ref)
          ? ('unchanged' as const)
          : ('create' as const),
      })),
      errors: names.includes('bad')
        ? [{ ref: 'bad', message: 'Refused.' }]
        : [],
      touched: held.filter((name) => names.includes(name)),
    }),
    import: async (_actor, names, context) => {
      imported(names, context.changes);
      held.push(...names.filter((name) => !held.includes(name)));
    },
  };
  return { handler, imported, held };
}

function setup(sections: Record<string, BundleSectionHandler>) {
  const registry = {
    find: (name: string) => sections[name],
    all: () =>
      Object.entries(sections).map(([name, handler]) => ({ name, handler })),
  } as unknown as BundleSections;
  const record = vi.fn();
  const service = new ConfigBundlesService(
    {
      withTransaction: (work: () => Promise<unknown>) => work(),
    } as unknown as TransactionHost<never>,
    registry,
    { record } as unknown as AuditService,
  );
  return { service, record };
}

const resealed = (bundle: ConfigBundle): ConfigBundle => ({
  ...bundle,
  checksum: checksumOf(bundle.contents),
});

describe('ConfigBundlesService', () => {
  it('sorts keys, so the same contents give the same checksum', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(
      '{"a":[{"c":null,"d":2}],"b":1}',
    );
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });

  it('exports every section, and previews its own export as unchanged', async () => {
    const { service } = setup({ names: namesSection(['b', 'a']).handler });
    const bundle = await service.export();
    expect(bundle.contents).toEqual({ names: ['a', 'b'] });
    expect(bundle.checksum).toBe(checksumOf(bundle.contents));
    const preview = await service.preview(bundle);
    expect(preview.valid).toBe(true);
    expect(
      preview.changes.every((change) => change.action === 'unchanged'),
    ).toBe(true);
  });

  it('refuses a damaged checksum, a newer format, an unknown section, a bad shape and an item its module refuses', async () => {
    const { service } = setup({ names: namesSection([]).handler });
    const bundle = await service.export();
    const damaged = await service.preview({
      ...bundle,
      checksum: `sha256:${'0'.repeat(64)}`,
    });
    expect(damaged.errors[0]!.message).toContain('checksum');

    const preview = await service.preview(
      resealed({
        ...bundle,
        version: 99,
        contents: { names: ['bad'], ghost: [], other: 'x' },
      }),
    );
    expect(preview.valid).toBe(false);
    expect(preview.errors.map((error) => [error.section, error.ref])).toEqual([
      [null, null],
      ['ghost', null],
      ['names', 'bad'],
      ['other', null],
    ]);
    const shape = await service.preview(
      resealed({ ...bundle, contents: { names: ['x'.repeat(11)] } }),
    );
    expect(shape.errors).toHaveLength(1);
  });

  it('applies the sections in order, in one go, with one audit entry', async () => {
    const first = namesSection([]);
    const second = namesSection(['kept']);
    const { service, record } = setup({
      first: first.handler,
      second: second.handler,
    });
    const source = await service.export();
    const bundle = resealed({
      ...source,
      contents: { first: ['one'], second: ['kept', 'two'] },
    });
    const preview = await service.preview(bundle);
    const counts = await service.apply(
      { kind: 'user' } as UserPrincipal,
      bundle,
      preview.targetVersion,
    );
    expect(counts).toEqual({ created: 2, updated: 0, unchanged: 1 });
    expect(first.imported).toHaveBeenCalledWith(
      ['one'],
      [{ ref: 'one', action: 'create' }],
    );
    expect(second.held).toEqual(['kept', 'two']);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('applies nothing when the target changed since the preview, or the bundle is invalid', async () => {
    const section = namesSection(['a']);
    const { service } = setup({ names: section.handler });
    const actor = { kind: 'user' } as UserPrincipal;
    const bundle = resealed({
      ...(await service.export()),
      contents: { names: ['a', 'new'] },
    });
    await expect(
      service.apply(actor, bundle, `sha256:${'f'.repeat(64)}`),
    ).rejects.toMatchObject({ response: { code: 'config_changed' } });
    const bad = resealed({ ...bundle, contents: { names: ['bad'] } });
    const { targetVersion } = await service.preview(bad);
    await expect(
      service.apply(actor, bad, targetVersion),
    ).rejects.toMatchObject({
      response: { code: 'validation_failed' },
    });
    expect(section.imported).not.toHaveBeenCalled();
  });
});

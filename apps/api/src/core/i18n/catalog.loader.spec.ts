import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleCatalogLoader } from './catalog.loader.js';

async function tree(files: Record<string, object>) {
  const root = await mkdtemp(join(tmpdir(), 'catalogs-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(content));
  }
  return root;
}

describe('ModuleCatalogLoader', () => {
  it('merges the i18n folders of every module, by locale', async () => {
    const root = await tree({
      'a/i18n/en.json': { a: { hello: 'Hello' } },
      'a/i18n/de.json': { a: { hello: 'Hallo' } },
      'deep/b/i18n/en.json': { b: { bye: 'Bye' }, a: { more: 'More' } },
    });
    const catalogs = await new ModuleCatalogLoader(root, ['en', 'de']).load();
    expect(catalogs).toEqual({
      en: { a: { hello: 'Hello', more: 'More' }, b: { bye: 'Bye' } },
      de: { a: { hello: 'Hallo' } },
    });
  });

  it('ignores locales that are not enabled and json outside i18n folders', async () => {
    const root = await tree({
      'a/i18n/en.json': { a: { x: 'x' } },
      'a/i18n/fr.json': { a: { x: 'x' } },
      'a/en.json': { z: 'z' },
    });
    expect(await new ModuleCatalogLoader(root, ['en']).load()).toEqual({
      en: { a: { x: 'x' } },
    });
  });

  it('fails when two modules define the same key', async () => {
    const root = await tree({
      'a/i18n/en.json': { shared: { k: '1' } },
      'b/i18n/en.json': { shared: { k: '2' } },
    });
    await expect(new ModuleCatalogLoader(root, ['en']).load()).rejects.toThrow(
      'already defined',
    );
  });
});

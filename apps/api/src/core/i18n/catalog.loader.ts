import { glob, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { I18nLoader, type I18nCatalog, type I18nCatalogs } from '@nestjs/i18n';

/**
 * Finds every `<module>/i18n/<locale>.json` under `root` and merges them, so a
 * module keeps its texts in its own folder and no central list names them.
 * @nestjs/i18n's JsonI18nLoader reads one `<path>/<locale>/*.json` tree, which
 * would need one shared folder. A file's top-level keys are namespaces
 * (`{ "validation": {...} }` is read as `validation.*`), and two files may not
 * define the same key. Only `locales` are read.
 */
export class ModuleCatalogLoader extends I18nLoader {
  constructor(
    private readonly root: string,
    private readonly locales: readonly string[],
  ) {
    super();
  }

  async load(): Promise<I18nCatalogs> {
    const catalogs: I18nCatalogs = {};
    const files: string[] = [];
    for await (const file of glob('**/i18n/*.json', { cwd: this.root })) {
      files.push(file);
    }
    for (const file of files.sort()) {
      const locale = basename(file, '.json');
      if (!this.locales.includes(locale)) continue;
      const content = JSON.parse(
        await readFile(join(this.root, file), 'utf8'),
      ) as I18nCatalog;
      merge((catalogs[locale] ??= {}), content, file);
    }
    return catalogs;
  }
}

function merge(
  target: I18nCatalog,
  source: I18nCatalog,
  file: string,
  path = '',
) {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (typeof value === 'object' && typeof current === 'object') {
      merge(current, value, file, `${path}${key}.`);
    } else if (current !== undefined) {
      throw new Error(
        `${file}: "${path}${key}" is already defined by another catalog`,
      );
    } else {
      target[key] = value;
    }
  }
}

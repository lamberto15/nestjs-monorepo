import { readdirSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  FileTemplateEngine,
  MailTemplateEngine,
  MailTemplateError,
  type MailTemplateRenderOptions,
} from '@nestjs/mail';
import { currentMailBrand } from './mail-brand.js';

/**
 * Finds every module's templates, wherever the module keeps them: a folder
 * named `templates` anywhere under a root (src, or dist once built), holding
 * `<name>.html`, `<name>.<locale>.html` and `<name>.txt` files, with
 * partials in its `partials/` folder. A template name is global: two
 * folders holding the same name stop the app at boot, naming both files.
 *
 * FileTemplateEngine reads one directory, so this engine keeps one of them
 * per folder, and wraps every HTML body in `layout.html` of `layoutDir`
 * (the shared layout, core/mail/templates).
 */
export class ModuleTemplateEngine extends MailTemplateEngine {
  private readonly folders = new Map<string, { dir: string; file: string }>();
  private readonly engines = new Map<string, FileTemplateEngine>();
  private readonly layout: FileTemplateEngine;

  constructor(
    roots: string[],
    private readonly layoutDir: string,
    private readonly cache: boolean,
  ) {
    super();
    this.layout = new FileTemplateEngine({ dir: layoutDir, cache });
    for (const root of roots) {
      for (const entry of readdirSync(root, {
        recursive: true,
        encoding: 'utf8',
      })) {
        this.register(root, entry);
      }
    }
  }

  private register(root: string, entry: string) {
    const parts = entry.split(sep);
    const at = parts.indexOf('templates');
    const rest = parts.slice(at + 1);
    const extension = /\.(html|txt)$/.exec(entry)?.[0];
    if (
      at < 0 ||
      !extension ||
      parts.includes('node_modules') ||
      rest[0] === 'partials'
    ) {
      return;
    }
    const dir = join(root, ...parts.slice(0, at + 1));
    if (dir === this.layoutDir) return;
    // A locale or the text version is part of the file name, not of the template's.
    const name = [...rest.slice(0, -1), basename(entry).split('.')[0]].join(
      '/',
    );
    const file = join(root, entry);
    const known = this.folders.get(name);
    if (known && known.dir !== dir) {
      throw new Error(
        `Mail template "${name}" exists twice: ${known.file} and ${file}. Template names are global: rename one.`,
      );
    }
    this.folders.set(name, { dir, file });
  }

  async render(
    name: string,
    context: object,
    options: MailTemplateRenderOptions,
  ) {
    const folder = this.folders.get(name);
    if (!folder) {
      throw new MailTemplateError(
        `No mail template "${name}": add ${name}.html to a templates/ folder of its module`,
        { template: name },
      );
    }
    let engine = this.engines.get(folder.dir);
    if (!engine) {
      engine = new FileTemplateEngine({ dir: folder.dir, cache: this.cache });
      this.engines.set(folder.dir, engine);
    }
    const brand = currentMailBrand();
    const { html, text } = (await engine.render(
      name,
      { brand, ...context },
      options,
    )) as {
      html: string;
      text?: string;
    };
    const wrapped = await this.layout.render(
      'layout',
      { brand, ...context, body: html },
      options,
    );
    return { html: (wrapped as { html: string }).html, text };
  }
}

/** The folder the shared layout is in. */
export const LAYOUT_DIR = join(import.meta.dirname, 'templates');
/** src, or dist once built: every module's templates are under it. */
export const SOURCE_ROOT = dirname(dirname(import.meta.dirname));

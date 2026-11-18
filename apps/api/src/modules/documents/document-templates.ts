import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { FileTemplateEngine } from '@nestjs/mail';
import { BrandingService } from '../branding/branding.service.js';

/** The module's own templates (`pdf-layout`, `pdf-record`), copied to dist by nest-cli.json. */
export const DOCUMENT_TEMPLATES_DIR = join(import.meta.dirname, 'templates');

/**
 * Languages written right to left. Custom: `Intl.Locale#getTextInfo()`
 * answers the same, but not in every runtime the template may run on (and
 * TypeScript's lib doesn't type it yet); the list is short and stable.
 */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/** `rtl` for a language written right to left (`ar`, `ar-AE`), else `ltr`. */
export const textDirection = (locale: string): 'rtl' | 'ltr' =>
  RTL_LANGUAGES.has(locale.split(/[-_]/)[0]!.toLowerCase()) ? 'rtl' : 'ltr';

/**
 * Renders a document's HTML from its template, wrapped in `pdf-layout`
 * (the page, the fonts, `lang` and `dir`). A record's template lives in
 * the folder its `forRecord()` names (default: this module's own).
 *
 * The engine is @nestjs/mail's FileTemplateEngine, already the mails'
 * engine, used as it is rather than a template library added for this:
 * Handlebars' syntax, every `{{ value }}` HTML-escaped, a `{{ }}` anywhere
 * else in a tag (an unquoted attribute, between attributes) a compile
 * error, a template per language when one exists (`note.ar.html`), and no
 * helpers, so templates can't run code. `{{{ raw }}}` exists for the
 * layout's body only: document-templates.spec.ts refuses it anywhere else.
 *
 * Nothing remote: the layout's Content-Security-Policy allows inline
 * styles and `data:` images and fonts only, and Gotenberg's Chromium is
 * allowed to load the page itself and nothing else, on a network without
 * egress.
 */
@Injectable()
export class DocumentTemplates {
  // Cached for good: a template change shows after a restart.
  private readonly layout = new FileTemplateEngine({
    dir: DOCUMENT_TEMPLATES_DIR,
    cache: true,
  });
  private readonly bodies = new Map<string, FileTemplateEngine>();

  constructor(private readonly branding: BrandingService) {}

  async render(
    template: { name: string; dir: string },
    context: Record<string, unknown>,
    { locale, title }: { locale: string; title: string },
  ): Promise<string> {
    let engine = this.bodies.get(template.dir);
    if (!engine) {
      engine = new FileTemplateEngine({ dir: template.dir, cache: true });
      this.bodies.set(template.dir, engine);
    }
    const page = {
      ...context,
      // The tenant's name, colour and logo (a data: URL): modules/branding.
      brand: await this.branding.forDocument(),
      lang: locale,
      dir: textDirection(locale),
      title,
    };
    const { html: body } = await engine.render(template.name, page, { locale });
    const { html } = await this.layout.render(
      'pdf-layout',
      { ...page, body },
      { locale },
    );
    return html;
  }
}

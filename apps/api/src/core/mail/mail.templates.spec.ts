import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYOUT_DIR, ModuleTemplateEngine } from './mail.templates.js';

function root(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('ModuleTemplateEngine', () => {
  it('finds the templates of every module and wraps them in the layout', async () => {
    const dir = root({
      'a/templates/one.html': '<p>one {{ x }}</p>',
      'b/deep/templates/two.html': '<p>two</p>',
      'b/deep/templates/two.fr.html': '<p>deux</p>',
    });
    const engine = new ModuleTemplateEngine([dir], LAYOUT_DIR, true);
    const one = await engine.render('one', { x: 1 }, { locale: undefined });
    expect(one).toMatchObject({ html: expect.stringContaining('one 1') });
    expect(one.html).toContain('<body');
    const two = await engine.render('two', {}, { locale: 'fr' });
    expect(two.html).toContain('deux');
  });

  it('stops at boot when two folders hold the same template, naming both files', () => {
    const dir = root({
      'a/templates/same.html': 'a',
      'b/templates/same.fr.html': 'b',
    });
    expect(() => new ModuleTemplateEngine([dir], LAYOUT_DIR, true)).toThrow(
      /"same" exists twice: .*a\/templates\/same\.html and .*b\/templates\/same\.fr\.html/,
    );
  });

  it('fails for a template nobody holds', async () => {
    const engine = new ModuleTemplateEngine([root({})], LAYOUT_DIR, true);
    await expect(
      engine.render('nope', {}, { locale: undefined }),
    ).rejects.toThrow('No mail template "nope"');
  });
});

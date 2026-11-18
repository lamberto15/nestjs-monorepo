import { describe, expect, it } from 'vitest';
import {
  assertDeclaredType,
  detectAttachmentType,
  isAllowedType,
} from './attachments.types.js';

describe('isAllowedType', () => {
  it('compares the type, not its parameters or its case', () => {
    const allowed = ['image/png', 'text/plain', 'text/csv'];
    expect(isAllowedType('text/plain; charset=utf-8', allowed)).toBe(true);
    expect(isAllowedType('IMAGE/PNG', allowed)).toBe(true);
    expect(isAllowedType('image/gif', allowed)).toBe(false);
    expect(isAllowedType('', allowed)).toBe(false);
  });
});

describe('detectAttachmentType', () => {
  it('types text as text (CSV when declared so), whatever it holds', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(detectAttachmentType(html, { mimetype: 'text/html' })).toBe(
      'text/plain; charset=utf-8',
    );
    expect(
      detectAttachmentType(Buffer.from('a,b\n1,2\n'), { mimetype: 'text/csv' }),
    ).toBe('text/csv; charset=utf-8');
  });

  it('refuses binary it does not know, and empty files', () => {
    expect(
      detectAttachmentType(Buffer.from([0, 1, 2, 250, 251]), {
        mimetype: 'application/octet-stream',
      }),
    ).toBeUndefined();
    expect(
      detectAttachmentType(Buffer.alloc(0), { mimetype: 'text/plain' }),
    ).toBeUndefined();
  });

  it('tells a zip from an Office document by its entries', () => {
    const entry = (name: string) => {
      const header = Buffer.alloc(30);
      header.set([0x50, 0x4b, 0x03, 0x04]);
      header.writeUInt16LE(name.length, 26);
      return Buffer.concat([header, Buffer.from(name)]);
    };
    expect(
      detectAttachmentType(entry('word/document.xml'), { mimetype: '' }),
    ).toContain('wordprocessingml');
    expect(detectAttachmentType(entry('a.txt'), { mimetype: '' })).toBe(
      'application/zip',
    );
  });
});

describe('assertDeclaredType', () => {
  it('refuses a file that is not what the client declared, not one that declared nothing', () => {
    expect(() =>
      assertDeclaredType('image/png', 'text/plain; charset=utf-8'),
    ).toThrow(/not image\/png/);
    expect(() =>
      assertDeclaredType('application/octet-stream', 'image/png'),
    ).not.toThrow();
    expect(() => assertDeclaredType('image/jpg', 'image/jpeg')).not.toThrow();
    expect(() =>
      assertDeclaredType('text/csv', 'text/plain; charset=utf-8'),
    ).not.toThrow();
  });
});

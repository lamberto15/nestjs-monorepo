import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { bootModules } from '../../../test/boot.js';
import { FILE_CSP } from './files.controller.js';
import { StorageModule } from './storage.module.js';

const PDF = Buffer.from('%PDF-1.7\nhello\n%%EOF\n');

describe('storage', () => {
  let app: NestNodeApplication;
  let disk: StorageDisk;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-e2e-'));
    Object.assign(process.env, {
      STORAGE_DRIVER: 'local',
      STORAGE_ROOT: root,
      STORAGE_SIGNING_KEYS: 'k'.repeat(40),
    });
    app = await bootModules(StorageModule);
    disk = app.get(StorageDisk);
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    for (const name of [
      'STORAGE_DRIVER',
      'STORAGE_ROOT',
      'STORAGE_SIGNING_KEYS',
    ]) {
      delete process.env[name];
    }
  });

  const pathOf = (url: string) => {
    const { pathname, search } = new URL(url);
    return pathname + search;
  };

  it('serves a signed URL with a locked-down policy, and nothing without one', async () => {
    await disk.put('docs/a.pdf', PDF, { contentType: 'application/pdf' });
    const url = await disk.signedUrl('docs/a.pdf', { expiresIn: '5m' });

    const res = await app.inject({ method: 'GET', url: pathOf(url) });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['content-security-policy']).toBe(FILE_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(
      (await app.inject({ method: 'GET', url: '/files' })).statusCode,
    ).toBe(403);
  });

  it('refuses a URL whose signature or key was changed', async () => {
    await disk.put('docs/b.pdf', PDF);
    const url = pathOf(await disk.signedUrl('docs/a.pdf'));
    const forged = url.replace('docs%2Fa.pdf', 'docs%2Fb.pdf');
    expect(forged).not.toBe(url);
    expect((await app.inject({ method: 'GET', url: forged })).statusCode).toBe(
      403,
    );
  });

  it('receives a signed upload onto the disk', async () => {
    const upload = await disk.signedUpload('in/c.pdf', {
      contentType: 'application/pdf',
      contentLength: PDF.length,
    });

    const res = await app.inject({
      method: 'PUT',
      url: pathOf(upload.url),
      headers: upload.headers,
      payload: PDF,
    });

    expect(res.statusCode).toBeLessThan(300);
    expect((await disk.getBuffer('in/c.pdf')).equals(PDF)).toBe(true);
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ArchiveError,
  archiveKey,
  CHUNK_BYTES,
  type Manifest,
  newArchiveKey,
  readEncrypted,
  readManifest,
  readRows,
  writeEncrypted,
  writeManifest,
} from './move-archive.js';

const read = async (dir: string, path: string, key: Buffer) => {
  const chunks: Buffer[] = [];
  for await (const chunk of readEncrypted(dir, path, key)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const manifest: Manifest = {
  format: 1,
  createdAt: '2026-11-19T00:00:00.000Z',
  schema: { latest: '20261118183611_tenant-frozen', digest: 'abc' },
  tenant: {
    id: '0199a000-0000-7000-8000-00000000000a',
    slug: 'acme',
    name: 'Acme',
  },
  tables: [],
  files: [],
  accounts: [],
  missingFiles: [],
};

describe('the move archive', () => {
  let dir: string;
  const key = archiveKey(newArchiveKey());
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenant-move-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('takes only its own key form: tmk1. and 32 bytes', () => {
    expect(archiveKey(newArchiveKey())).toHaveLength(32);
    expect(newArchiveKey()).not.toBe(newArchiveKey());
    for (const wrong of [
      '',
      'tmk1.',
      'tmk1.abc',
      randomBytes(32).toString('base64url'),
    ]) {
      expect(() => archiveKey(wrong)).toThrow(ArchiveError);
    }
  });

  it('round-trips files of every size, streamed in chunks, and reports their size and checksum', async () => {
    for (const size of [
      0,
      1,
      CHUNK_BYTES - 1,
      CHUNK_BYTES,
      CHUNK_BYTES + 1,
      3 * CHUNK_BYTES + 7,
    ]) {
      const plain = randomBytes(size);
      const path = `files/${size}`;
      await mkdir(join(dir, 'files'), { recursive: true });
      // Small pieces, as a disk's stream hands them over.
      const pieces = Array.from({ length: Math.ceil(size / 1000) }, (_, i) =>
        plain.subarray(i * 1000, (i + 1) * 1000),
      );
      const written = await writeEncrypted(
        dir,
        path,
        key,
        Readable.from(pieces),
      );
      expect(written).toEqual({
        bytes: size,
        sha256: createHash('sha256').update(plain).digest('hex'),
      });
      const stored = await readFile(join(dir, path));
      if (size >= 64) {
        expect(stored.includes(plain.subarray(0, 64))).toBe(false);
      }
      expect((await read(dir, path, key)).equals(plain)).toBe(true);
    }
  });

  it('refuses a wrong key, an altered byte, a cut-off end, an extra record and a file moved to another name', async () => {
    const plain = randomBytes(2 * CHUNK_BYTES + 10);
    await writeEncrypted(dir, 'a', key, Readable.from([plain]));
    const stored = await readFile(join(dir, 'a'));
    const refuses = (path: string, with_ = key) =>
      expect(read(dir, path, with_)).rejects.toThrow(ArchiveError);

    await refuses('a', archiveKey(newArchiveKey()));

    const altered = Buffer.from(stored);
    altered[100] = altered[100]! ^ 1;
    await writeFile(join(dir, 'altered'), altered);
    await refuses('altered');

    // Without its last record: every record that is left still opens.
    const lastRecord = 5 + 10 + 16;
    await writeFile(
      join(dir, 'cut'),
      stored.subarray(0, stored.length - lastRecord),
    );
    await refuses('cut');

    await writeFile(
      join(dir, 'extra'),
      Buffer.concat([stored, stored.subarray(20, 20 + lastRecord)]),
    );
    await refuses('extra');

    // The same bytes under another path: the path is authenticated.
    await writeFile(join(dir, 'b'), stored);
    await refuses('b');
  });

  it('writes NDJSON rows that read back one object at a time', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      i,
      text: `é${i}\n`,
    }));
    await writeEncrypted(
      dir,
      'rows',
      key,
      Readable.from(rows.map((row) => Buffer.from(`${JSON.stringify(row)}\n`))),
    );
    const back: unknown[] = [];
    for await (const row of readRows(dir, 'rows', key)) back.push(row);
    expect(back).toEqual(rows);
  });

  it('keeps the manifest encrypted, and opens it only with its key', async () => {
    await writeManifest(dir, key, manifest);
    const stored = await readFile(join(dir, 'manifest.json'));
    expect(stored.toString('latin1')).not.toContain('acme');
    expect(await readManifest(dir, key)).toEqual(manifest);
    await expect(
      readManifest(dir, archiveKey(newArchiveKey())),
    ).rejects.toThrow(ArchiveError);
    await expect(readManifest(join(dir, 'none'), key)).rejects.toThrow(
      'holds no tenant archive',
    );
  });

  it('refuses a manifest of another format', async () => {
    await writeManifest(dir, key, {
      ...manifest,
      format: 2,
    } as unknown as Manifest);
    await expect(readManifest(dir, key)).rejects.toThrow('not a manifest');
  });
});

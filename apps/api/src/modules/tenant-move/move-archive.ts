import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

/**
 * The archive of a tenant's move (README.md, "The archive"): a directory of
 * files, each encrypted on its own, so every part streams in and out and
 * nothing is held whole in memory.
 *
 * Each file is AES-256-GCM in chunks of 64 KiB (the STREAM construction):
 * a header (`TMV1` and a random 16-byte salt), then records of
 * `[final: 1 byte][length: 4 bytes][ciphertext][tag: 16 bytes]`. The file's
 * key is HKDF-SHA-256 of the archive key with its salt, so no two files
 * share a key and a chunk's nonce can be its index. Each record
 * authenticates the file's path in the archive, its index and whether it is
 * the last, so a record moved, dropped, reordered, swapped with another
 * file's or cut off at the end fails to open. Standard primitives from
 * node:crypto only.
 *
 * The archive key is 32 random bytes, printed once by the export
 * (`tmk1.<base64url>`) and given to the import; it is never written to
 * disk by either.
 */

const MAGIC = Buffer.from('TMV1');
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES;
const RECORD_HEAD = 5;
/** Plaintext per record. */
export const CHUNK_BYTES = 64 * 1024;
const KEY_PREFIX = 'tmk1.';

/** An archive that can't be read: a wrong key, a file altered or cut short, an unknown format. */
export class ArchiveError extends Error {}

/** A new archive key, as the operator copies it. */
export const newArchiveKey = () =>
  `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

/** The 32 bytes of an archive key as `newArchiveKey()` wrote it. */
export function archiveKey(text: string): Buffer {
  const trimmed = text.trim();
  const bytes = trimmed.startsWith(KEY_PREFIX)
    ? Buffer.from(trimmed.slice(KEY_PREFIX.length), 'base64url')
    : Buffer.alloc(0);
  if (bytes.length !== 32) {
    throw new ArchiveError(
      'Not an archive key: it is the tmk1.… line tenant:export printed.',
    );
  }
  return bytes;
}

const fileKey = (key: Buffer, salt: Buffer) =>
  Buffer.from(hkdfSync('sha256', key, salt, 'tenant-move archive v1', 32));

const nonceOf = (index: number) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
};

const aadOf = (path: string, index: number, final: boolean) => {
  const fixed = Buffer.alloc(9);
  fixed.writeBigUInt64BE(BigInt(index), 0);
  fixed[8] = final ? 1 : 0;
  return Buffer.concat([fixed, Buffer.from(path, 'utf8')]);
};

/** Encrypts a stream as the archive's file `path`. */
export function encryptor(key: Buffer, path: string): Transform {
  const salt = randomBytes(SALT_BYTES);
  const secret = fileKey(key, salt);
  let index = 0;
  let pending = Buffer.alloc(0);
  let started = false;
  const seal = (plain: Buffer, final: boolean) => {
    const cipher = createCipheriv('aes-256-gcm', secret, nonceOf(index), {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aadOf(path, index, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.alloc(RECORD_HEAD);
    head[0] = final ? 1 : 0;
    head.writeUInt32BE(body.length, 1);
    index++;
    return Buffer.concat([head, body, cipher.getAuthTag()]);
  };
  const header = (stream: Transform) => {
    if (!started) {
      stream.push(Buffer.concat([MAGIC, salt]));
      started = true;
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      header(this);
      pending = Buffer.concat([pending, chunk]);
      // A full chunk is sealed only once more follows: the last is marked final.
      while (pending.length > CHUNK_BYTES) {
        this.push(seal(pending.subarray(0, CHUNK_BYTES), false));
        pending = pending.subarray(CHUNK_BYTES);
      }
      done();
    },
    flush(done: TransformCallback) {
      header(this);
      this.push(seal(pending, true));
      done();
    },
  });
}

/** Decrypts the archive's file `path`; an ArchiveError when it doesn't open whole. */
export function decryptor(key: Buffer, path: string): Transform {
  let buffer = Buffer.alloc(0);
  let secret: Buffer | undefined;
  let index = 0;
  let finished = false;
  const refuse = () =>
    new ArchiveError(
      `${path}: does not open with this key, or was altered or cut short.`,
    );
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!secret) {
          if (buffer.length < HEADER_BYTES) return done();
          if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw refuse();
          secret = fileKey(key, buffer.subarray(MAGIC.length, HEADER_BYTES));
          buffer = buffer.subarray(HEADER_BYTES);
        }
        while (buffer.length >= RECORD_HEAD) {
          if (finished) throw refuse();
          const final = buffer[0] === 1;
          const length = buffer.readUInt32BE(1);
          if (buffer[0]! > 1 || length > CHUNK_BYTES) throw refuse();
          const end = RECORD_HEAD + length + TAG_BYTES;
          if (buffer.length < end) break;
          const decipher = createDecipheriv(
            'aes-256-gcm',
            secret,
            nonceOf(index),
            { authTagLength: TAG_BYTES },
          );
          decipher.setAAD(aadOf(path, index, final));
          decipher.setAuthTag(buffer.subarray(end - TAG_BYTES, end));
          let plain: Buffer;
          try {
            plain = Buffer.concat([
              decipher.update(buffer.subarray(RECORD_HEAD, end - TAG_BYTES)),
              decipher.final(),
            ]);
          } catch {
            throw refuse();
          }
          this.push(plain);
          buffer = buffer.subarray(end);
          index++;
          finished = final;
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      done(finished && buffer.length === 0 ? undefined : refuse());
    },
  });
}

/** A pass-through that counts and hashes (SHA-256) what crosses it. */
export function measure() {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  let digest: string | undefined;
  return {
    stream,
    bytes: () => bytes,
    sha256: () => (digest ??= hash.digest('hex')),
  };
}

/** Writes `source` encrypted to `<dir>/<path>`; its plaintext's size and SHA-256. */
export async function writeEncrypted(
  dir: string,
  path: string,
  key: Buffer,
  source: Readable | AsyncIterable<Buffer | string>,
) {
  const measured = measure();
  await pipeline(
    source,
    measured.stream,
    encryptor(key, path),
    createWriteStream(join(dir, path), { flags: 'wx', mode: 0o600 }),
  );
  return { bytes: measured.bytes(), sha256: measured.sha256() };
}

/** `<dir>/<path>` decrypted, as a stream (errors as it is read). */
export function readEncrypted(dir: string, path: string, key: Buffer) {
  const source = createReadStream(join(dir, path));
  const decrypt = decryptor(key, path);
  source.on('error', (error) => decrypt.destroy(error));
  return source.pipe(decrypt);
}

/** The lines of a decrypted NDJSON file, one parsed object at a time. */
export async function* readRows(
  dir: string,
  path: string,
  key: Buffer,
): AsyncIterable<Record<string, unknown>> {
  let rest = '';
  for await (const chunk of readEncrypted(dir, path, key)) {
    rest += (chunk as Buffer).toString('utf8');
    let newline = rest.indexOf('\n');
    while (newline >= 0) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
      newline = rest.indexOf('\n');
    }
  }
  if (rest) yield JSON.parse(rest) as Record<string, unknown>;
}

// The manifest

export const MANIFEST_PATH = 'manifest.json';
export const ARCHIVE_FORMAT = 1;

const tableEntry = z.object({
  /** The table's name. */
  name: z.string(),
  /** `tenant`: the tenant's row; `users`: the accounts; `account`: an account's rows; `rows`: a table naming the tenant. */
  kind: z.enum(['tenant', 'users', 'account', 'rows']),
  path: z.string(),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  /** Properties written in clear here, encrypted again with the target's keys. */
  encrypted: z.array(z.string()),
});

const fileEntry = z.object({
  /** The object key on the disk, the same on both servers. */
  key: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  contentType: z.string(),
  cacheControl: z.string().optional(),
  contentDisposition: z.string().optional(),
  metadata: z.record(z.string(), z.string()),
});

export const manifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  createdAt: z.string(),
  /** The source's schema (core/database schemaVersion()): the target's must be the same. */
  schema: z.object({ latest: z.string(), digest: z.string() }),
  tenant: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  /** In the order the target inserts them in is derived there, from the keys. */
  tables: z.array(tableEntry),
  files: z.array(fileEntry),
  /** Every account copied, and the source's other tenants it also belongs to. */
  accounts: z.array(
    z.object({
      id: z.uuid(),
      email: z.string(),
      elsewhere: z.array(z.string()),
    }),
  ),
  /** Files a copied row names that the source's disk did not have. */
  missingFiles: z.array(z.string()),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type TableEntry = z.infer<typeof tableEntry>;
export type FileEntry = z.infer<typeof fileEntry>;

/** Writes the manifest, encrypted like every other file. */
export async function writeManifest(
  dir: string,
  key: Buffer,
  manifest: Manifest,
) {
  await writeEncrypted(
    dir,
    MANIFEST_PATH,
    key,
    Readable.from([Buffer.from(JSON.stringify(manifest))]),
  );
}

/** The archive's manifest, opened with `key` and checked; an ArchiveError otherwise. */
export async function readManifest(
  dir: string,
  key: Buffer,
): Promise<Manifest> {
  try {
    await stat(join(dir, MANIFEST_PATH));
  } catch {
    throw new ArchiveError(
      `${dir} holds no tenant archive (no ${MANIFEST_PATH}).`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of readEncrypted(dir, MANIFEST_PATH, key)) {
    chunks.push(chunk as Buffer);
  }
  const parsed = manifestSchema.safeParse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
  if (!parsed.success) {
    throw new ArchiveError(
      `${MANIFEST_PATH}: not a manifest this release reads (format ${ARCHIVE_FORMAT}).`,
    );
  }
  return parsed.data;
}

import { randomUUID } from 'node:crypto';
import type { ConfigType } from '@nestjs/config';
import type { httpConfig } from '../../core/http/http.config.js';
import { createStorageOptions } from './storage.disks.js';
import type { storageConfig } from './storage.config.js';

/**
 * The `s3` disk as the app makes it, against a real S3-compatible store:
 * the development Garage (`pnpm storage:up`; CI's storage step). Runs when
 * S3_TEST_ENDPOINT is set (with S3_TEST_BUCKET and the AWS_* key the setup
 * prints); skipped otherwise.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.runIf(endpoint)('storage on S3 (e2e)', () => {
  const disk = async () => {
    const options = await createStorageOptions(
      {
        driver: 's3',
        root: '',
        signingKeys: ['unused'],
        s3: {
          bucket: process.env.S3_TEST_BUCKET ?? 'app-dev',
          region: process.env.S3_TEST_REGION ?? 'garage',
          endpoint,
          forcePathStyle: true,
        },
      } as ConfigType<typeof storageConfig>,
      { appUrl: 'http://localhost:3000' } as ConfigType<typeof httpConfig>,
    );
    return options.disks!.files!;
  };

  it('takes a presigned upload and serves it back through a presigned link', async () => {
    const files = await disk();
    const key = `tests/${randomUUID()}.txt`;
    const body = 'hello from a browser';
    const upload = await files.signedUpload(key, {
      contentType: 'text/plain',
      contentLength: Buffer.byteLength(body),
    });
    const put = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect(put.status, await put.clone().text()).toBe(200);
    try {
      expect(await files.stat(key)).toMatchObject({
        size: Buffer.byteLength(body),
        contentType: 'text/plain',
      });
      const download = await fetch(
        await files.signedUrl(key, { filename: 'hello.txt' }),
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(body);
      expect(download.headers.get('content-disposition')).toContain(
        'hello.txt',
      );
    } finally {
      await files.delete(key);
    }
  });
});

import { randomBytes } from 'node:crypto';
import type { ConfigType } from '@nestjs/config';
import {
  InMemoryDisk,
  LocalDisk,
  S3Disk,
  type StorageDisk,
  type StorageModuleOptions,
} from '@nestjs/storage';
import type { httpConfig } from '../../core/http/http.config.js';
import type { storageConfig } from './storage.config.js';

/** The route that serves the local disk's signed URLs (FilesController). */
export const FILES_ROUTE = 'files';

/**
 * One private disk, `files` (the default, injected as `StorageDisk`).
 * Nothing on it is public: clients get short-lived signed URLs
 * (`disk.signedUrl(key)`, `disk.signedUpload(key, …)`). Locally the app
 * serves them at /files; on S3 they point at the bucket. Add disks here (a
 * public one behind a CDN, say) and inject them with `@InjectDisk('name')`.
 */
export function createStorageOptions(
  config: ConfigType<typeof storageConfig>,
  http: ConfigType<typeof httpConfig>,
): StorageModuleOptions {
  const signedUrls = {
    baseUrl: `${http.appUrl}/${FILES_ROUTE}`,
    keys: config.signingKeys.length
      ? config.signingKeys
      : [randomBytes(32).toString('base64url')],
  };
  let files: StorageDisk;
  switch (config.driver) {
    case 's3': {
      if (!config.s3.bucket) {
        throw new Error('S3_BUCKET is required with STORAGE_DRIVER=s3');
      }
      files = new S3Disk({
        bucket: config.s3.bucket,
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        forcePathStyle: config.s3.forcePathStyle,
        // Objects encrypted at rest by the store.
        serverSideEncryption: 'AES256',
        timeout: '60s',
      });
      break;
    }
    case 'memory':
      files = new InMemoryDisk({ signedUrls });
      break;
    default:
      files = new LocalDisk({ root: config.root, signedUrls });
  }
  return { default: 'files', disks: { files } };
}

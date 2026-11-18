import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  choice,
  flag,
  list,
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Where files go: `local` (STORAGE_ROOT), `s3` (any S3-compatible store), `memory` (tests). */
  STORAGE_DRIVER: choice(['local', 's3', 'memory'], 'local'),
  /** The folder of the local disk; relative paths resolve against the working directory. */
  STORAGE_ROOT: withDefault('.data/storage'),
  /**
   * Signs the app-served file URLs (local and memory disks): 32+ characters
   * each, comma-separated, newest first. Unset, one is made once and kept in the
   * database (core/secrets), so every instance signs with the same.
   */
  STORAGE_SIGNING_KEYS: secret(list()),
  /** The bucket, required with STORAGE_DRIVER=s3. */
  S3_BUCKET: optional(),
  /** `auto` for Cloudflare R2. Default: AWS_REGION, then us-east-1. */
  S3_REGION: optional(),
  /** S3-compatible endpoints: https://<account>.r2.cloudflarestorage.com, http://garage:3900… */
  S3_ENDPOINT: optional(),
  /** Garage and most self-hosted stores. */
  S3_FORCE_PATH_STYLE: flag('off'),
});

/**
 * S3 credentials are not here: S3Disk reads the standard AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN (or the instance's role).
 */
export const storageConfig = registerAs('storage', () => {
  const env = readEnv(schema);
  return {
    driver: env.STORAGE_DRIVER,
    root: env.STORAGE_ROOT,
    signingKeys: env.STORAGE_SIGNING_KEYS,
    s3: {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
  };
});

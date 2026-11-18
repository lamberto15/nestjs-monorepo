import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { storageConfig } from '../storage/storage.config.js';

/**
 * `presignedUploads` of `GET /v1/features`: whether files can go straight
 * to the object store (STORAGE_DRIVER=s3), as the presign routes decide it.
 */
@Feature('presignedUploads')
@Injectable()
export class PresignedUploadsFeature implements FeatureSwitch {
  constructor(
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  value() {
    return this.storage.driver === 's3';
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule as NestStorageModule } from '@nestjs/storage';
import { httpConfig } from '../../core/http/http.config.js';
import { Secrets } from '../../core/secrets/secrets.service.js';
import { FilesController } from './files.controller.js';
import { storageConfig } from './storage.config.js';
import { createStorageOptions } from './storage.disks.js';

/**
 * Files on @nestjs/storage's disks. Its module is global, so a service
 * injects `StorageDisk` (the private `files` disk) without importing this one.
 */
@Module({
  imports: [
    NestStorageModule.forRootAsync({
      imports: [
        ConfigModule.forFeature(storageConfig),
        ConfigModule.forFeature(httpConfig),
      ],
      inject: [
        storageConfig.KEY,
        httpConfig.KEY,
        // There when the app has SecretsModule (a test may boot without).
        { token: Secrets, optional: true },
      ],
      useFactory: createStorageOptions,
    }),
  ],
  controllers: [FilesController],
})
export class StorageModule {}

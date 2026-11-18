import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule as NestStorageModule } from '@nestjs/storage';
import { csrfExclusions } from '../../core/http/http-setup.js';
import { httpConfig } from '../../core/http/http.config.js';
import { Secrets } from '../../core/secrets/secrets.service.js';
import { FilesController } from './files.controller.js';
import { StorageDiagnostic } from './storage.diagnostic.js';
import { storageConfig } from './storage.config.js';
import { createStorageOptions, FILES_ROUTE } from './storage.disks.js';

// A signed upload (PUT /files) carries its credential in the URL, not a
// cookie: a browser page on another origin may send it.
csrfExclusions.set('storage.signed-upload', {
  path: FILES_ROUTE,
  method: RequestMethod.PUT,
});

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
  providers: [StorageDiagnostic],
})
export class StorageModule {}

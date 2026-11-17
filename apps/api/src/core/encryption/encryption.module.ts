import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { encryptionConfig } from './encryption.config.js';
import { EncryptionService } from './encryption.service.js';
import { ReencryptionService } from './reencryption.service.js';

/** Encrypting columns at rest: global, so any module's service injects EncryptionService. */
@Global()
@Module({
  imports: [ConfigModule.forFeature(encryptionConfig), DiscoveryModule],
  providers: [EncryptionService, ReencryptionService],
  exports: [EncryptionService, ReencryptionService],
})
export class EncryptionModule {}

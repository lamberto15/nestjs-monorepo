import { Global, Module } from '@nestjs/common';
import { Secrets } from './secrets.service.js';

/**
 * Secrets made once and kept in the database (README.md). Global: any
 * module that needs a shared key injects `Secrets`. Needs DatabaseModule and
 * EncryptionModule (global).
 */
@Global()
@Module({
  providers: [Secrets],
  exports: [Secrets],
})
export class SecretsModule {}

import { Global, Module } from '@nestjs/common';
import { SecretsRepository } from './secrets.repository.js';
import { Secrets } from './secrets.service.js';

/**
 * Secrets made once and kept in the database (README.md). Global: any
 * module that needs a shared key injects `Secrets`. Needs DatabaseModule and
 * EncryptionModule (global).
 */
@Global()
@Module({
  providers: [Secrets, SecretsRepository],
  exports: [Secrets],
})
export class SecretsModule {}

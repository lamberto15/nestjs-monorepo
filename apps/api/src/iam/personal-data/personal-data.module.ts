import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { httpConfig } from '../../core/http/http.config.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { HoldsModule } from '../holds/holds.module.js';
import { AccountDeletionJob } from './account-deletion.job.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { ConsentKinds } from './consent-kinds.js';
import { ConsentsService } from './consents.service.js';
import { DeletionCancelLinks } from './deletion-cancel-links.js';
import { personalDataConfig } from './personal-data.config.js';
import {
  AccountController,
  AccountDeletionLinkController,
  ConsentKindsController,
} from './personal-data.controller.js';
import { AccountDeletionMail } from './personal-data.mails.js';
import { PERSONAL_DATA_PERMISSIONS } from './personal-data.permissions.js';
import {
  AccountSection,
  AuditSection,
  ConsentsSection,
} from './personal-data.sections.js';
import { RolesSection, UnitsSection } from './personal-data.memberships.js';
import { PersonalDataService } from './personal-data.service.js';

/**
 * A person's own data (README.md): the `@PersonalData()` sections every
 * module adds, their export (PersonalDataService, for the module that
 * writes the file) and their erasure when the account is deleted; the
 * deletion itself (request, grace period, cancel, the nightly job) and
 * consents. Needs AuthModule (global), the queues (mail) and the database.
 */
@Module({
  imports: [
    DiscoveryModule,
    ConfigModule.forFeature(personalDataConfig),
    ConfigModule.forFeature(httpConfig),
    AccessModule.forFeature(PERSONAL_DATA_PERMISSIONS),
    AuditModule,
    HoldsModule,
    MailModule,
    SecretsModule,
  ],
  controllers: [
    AccountController,
    AccountDeletionLinkController,
    ConsentKindsController,
  ],
  providers: [
    PersonalDataService,
    AccountDeletionService,
    AccountDeletionJob,
    AccountDeletionMail,
    DeletionCancelLinks,
    ConsentKinds,
    ConsentsService,
    AccountSection,
    ConsentsSection,
    AuditSection,
    RolesSection,
    UnitsSection,
  ],
  // AccountDeletionJob: deleteNow() for the operator CLI's tenant move.
  exports: [PersonalDataService, AccountDeletionJob],
})
export class PersonalDataModule {}

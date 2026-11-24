import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { ChoicesModule } from '../choices/choices.module.js';
import { RetentionModule } from '../retention/retention.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  FormPublicLinksController,
  PublicFormsController,
} from './form-links.controller.js';
import { FormPublicLinksService } from './form-links.service.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import { FormSubmissionsController } from './form-submissions.controller.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { FormsController } from './forms.controller.js';
import { FORM_PERMISSIONS } from './forms.permissions.js';
import { FormSubmissionsPersonalData } from './forms.personal-data.js';
import { FormPolicy } from './forms.policy.js';
import { FormsRepository } from './forms.repository.js';
import { FormsService } from './forms.service.js';
import { FORM_SETTINGS } from './forms.settings.js';
import { formSubmissions } from './forms.tables.js';

/**
 * Runtime forms (README.md): definitions, published versions, submissions
 * and public links. A leaf: nothing imports it.
 */
@Module({
  imports: [
    ConfigModule.forFeature(httpConfig),
    AccessModule.forFeature(FORM_PERMISSIONS),
    AuditModule,
    ChoicesModule,
    SettingsModule.forFeature(FORM_SETTINGS),
    // Off until a tenant turns it on (modules/retention).
    RetentionModule.forFeature({
      name: 'form-submission',
      label: 'Form submissions',
      subject: 'Form',
      table: formSubmissions,
      ageColumn: formSubmissions.createdAt,
      action: 'purge',
      defaultDays: 730,
      minDays: 30,
    }),
  ],
  controllers: [
    FormsController,
    FormSubmissionsController,
    FormPublicLinksController,
    PublicFormsController,
  ],
  providers: [
    FormPolicy,
    FormsService,
    FormsRepository,
    FormSubmissionsService,
    FormPublicLinksService,
    FormOptionSourcesService,
    FormSubmissionsPersonalData,
  ],
})
export class FormsModule {}

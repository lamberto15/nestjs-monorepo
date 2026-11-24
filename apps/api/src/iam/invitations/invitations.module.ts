import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { InvitationUnits } from './invitation-units.js';
import {
  AcceptInvitationController,
  InvitationsController,
} from './invitations.controller.js';
import { invitationsConfig } from './invitations.config.js';
import { TenantInvitationMail } from './invitations.mail.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';

/**
 * Adding people to a tenant by invitation (README.md): inviting, preparing,
 * sending, changing and withdrawing them (`Access.manageUsers`), the mail,
 * and accepting one with its link. Imports AccessModule and
 * OrganizationModule (units); needs MailModule's queue and, to accept a new
 * account, BreachedPasswordsService (iam/account) somewhere in the app.
 * `InvitationsService.create()` is for the module that makes a tenant.
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    OrganizationModule,
    MailModule,
    ConfigModule.forFeature(invitationsConfig),
    ConfigModule.forFeature(httpConfig),
  ],
  controllers: [InvitationsController, AcceptInvitationController],
  providers: [
    InvitationsService,
    InvitationsRepository,
    InvitationUnits,
    TenantInvitationMail,
  ],
  exports: [InvitationsService],
})
export class InvitationsModule {}

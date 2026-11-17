import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { minutes } from '@nestjs/throttler';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../access/access.policy.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../auth/onboarding.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { UserThrottle } from '../auth/user-throttle.guard.js';
import {
  acceptedInvitationSchema,
  acceptSchema,
  inviteSchema,
  invitationSchema,
  pendingInvitationSchema,
  updateInvitationSchema,
} from './invitations.schemas.js';
import { InvitationsService } from './invitations.service.js';

/**
 * Inviting and preparing members, and managing the invitations pending
 * (`Access.manageUsers`; user sessions only). Roles are privileges: what
 * hands them out asks for a recent sign-in.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@Controller('access')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('users')
  @Can(AccessPolicy, 'manageUsers')
  // Roles are privileges (a stale stolen session must not hand them out);
  // an invitation without any stays frequent administration.
  @RecentAuthentication({
    when: ({ body }) => {
      const sent = body as { roleIds?: unknown } | undefined;
      return Array.isArray(sent?.roleIds) && sent.roleIds.length > 0;
    },
  })
  @HttpCode(202)
  @ApiOperation({
    summary: 'Invite or prepare a member of this tenant',
    description:
      "An invitation with the membership's roles and units. `send: true` (invite, the default): the address is emailed a link (WEB_URL/accept-invitation?token=…, valid INVITATION_TTL_HOURS). `send: false` (prepare): no link and no access until POST /access/invitations/{id}/send; the address may come later (PATCH /access/invitations/{id}). A new address chooses its password with the link; an existing account accepts while signed in (POST /auth/invitations/accept). The membership comes then. The answer is the same whether or not the address has an account; nobody sets another person's password. 400 `email_required`: sending without an address.",
  })
  @ApiAcceptedResponse({ standardSchema: invitationSchema })
  invite(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: inviteSchema }) body: z.infer<typeof inviteSchema>,
    @Ip() ip: string,
  ) {
    return this.invitations.invite(user, body, ip);
  }

  @Get('invitations')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({ summary: "This tenant's invitations not accepted yet" })
  @ApiOkResponse({ standardSchema: listSchema(pendingInvitationSchema) })
  async pending() {
    return { items: await this.invitations.pending() };
  }

  @Patch('invitations/:id')
  @Can(AccessPolicy, 'manageUsers')
  // Roles are privileges, and a new address sends them to another mailbox.
  @RecentAuthentication({
    when: ({ body }) => {
      const sent = body as { roleIds?: unknown; email?: unknown } | undefined;
      return sent?.roleIds !== undefined || sent?.email !== undefined;
    },
  })
  @ApiOperation({
    summary: 'Change a pending invitation; only what is sent changes',
    description:
      'Prepared or sent: its address, the name a new account starts with, roles, their ends and units. You must be able to grant its roles and place people in its units, those it has and those it gets. A new address withdraws a sent link (`status: prepared`: send it again).',
  })
  @ApiOkResponse({ standardSchema: invitationSchema })
  @ApiNotFoundResponse({ description: 'No pending invitation of this id.' })
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateInvitationSchema })
    body: z.infer<typeof updateInvitationSchema>,
    @Ip() ip: string,
  ) {
    return this.invitations.update(user, id, body, ip);
  }

  @Post('invitations/:id/send')
  @Can(AccessPolicy, 'manageUsers')
  // A new link that hands out the invitation's roles: as inviting with roles.
  @RecentAuthentication()
  // Each one mails an address.
  @UserThrottle({ limit: 30, ttl: minutes(15) })
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a pending invitation: its link, or a new one',
    description:
      'Prepared, sent or expired. A new link and expiry; a previous link stops working; the roles, their ends (`roleExpiresAt`) and the units stay as they are. You must be able to grant its roles and place people in its units, as when inviting. 400 `email_required`: it has no address yet.',
  })
  @ApiAcceptedResponse({ standardSchema: invitationSchema })
  @ApiNotFoundResponse({ description: 'No pending invitation of this id.' })
  send(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.invitations.send(user, id, ip);
  }

  @Delete('invitations/:id')
  @Can(AccessPolicy, 'manageUsers')
  @HttpCode(204)
  @ApiOperation({ summary: 'Withdraw an invitation: its link stops working' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revoke(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.invitations.revoke(user, id, ip);
  }
}

/** The invitation's link lands here: the one route of this module a guest may call. */
@ApiTags('auth')
@Controller('auth')
export class AcceptInvitationController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * An invitation's link (WEB_URL/accept-invitation?token=…) posts here. A
   * new address chooses its password (`password`, and a `name`); an existing
   * account accepts while signed in as itself. Either way the membership
   * comes now, with the invitation's roles and units.
   */
  @UserOnly({ optional: true })
  @Can.Anyone()
  // The global limit only: a token is 256 random bits (nothing to guess),
  // and the one hash a new account costs waits for its slot.
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation to a tenant',
    description:
      '400 `password_required`: a new address, send `password` (and `name`). 401 `sign_in_required`: the address has an account, sign in to it and accept again. 403 `invitation_other_account`: you are signed in as another account. 400 `invitation_invalid`: unknown, used or expired. A new account signs in afterwards (POST /auth/sign-in); a signed-in one switches to the tenant (POST /auth/tenant).',
  })
  @ApiOkResponse({ standardSchema: acceptedInvitationSchema })
  @ApiBadRequestResponse({
    description:
      '`invitation_invalid`, `password_required`, `password_breached`.',
  })
  async accept(
    @CurrentUser() user: UserPrincipal | null,
    @Body({ schema: acceptSchema }) body: z.infer<typeof acceptSchema>,
    @Ip() ip: string,
  ) {
    const { tenantId, accountCreated } = await this.invitations.accept(
      body.token,
      { password: body.password, name: body.name },
      user,
      ip,
    );
    return { tenantId, accountCreated };
  }
}

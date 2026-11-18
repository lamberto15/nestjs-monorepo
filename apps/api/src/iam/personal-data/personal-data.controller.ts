import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  Public,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { AddressThrottle } from '../auth/address-throttle.guard.js';
import { notWhileImpersonating } from '../auth/impersonation.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { UserThrottle } from '../auth/user-throttle.guard.js';
import { AccountDeletionService, view } from './account-deletion.service.js';
import { ConsentKinds } from './consent-kinds.js';
import { ConsentsService } from './consents.service.js';
import {
  acceptConsentSchema,
  accountStateSchema,
  cancelDeletionByLinkSchema,
  consentKindSchema,
  consentSchema,
  deletionSchema,
  requestDeletionSchema,
} from './personal-data.schemas.js';

/**
 * A person's rights over their own account: its deletion, and a record of
 * what they agreed to. Users only, never while impersonating: the account
 * is the person's, not an administrator's to act on in one tenant.
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('account')
export class AccountController {
  constructor(
    private readonly deletions: AccountDeletionService,
    private readonly consents: ConsentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your account: a pending deletion, what you agreed to',
  })
  @ApiOkResponse({ standardSchema: accountStateSchema })
  async state(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    const deletion = await this.deletions.pending(user.id);
    return {
      deletion: deletion ? view(deletion) : null,
      consents: await this.consents.latest(user.id),
    };
  }

  // The password is checked here: limited like signing in, per address and per account.
  @Post('deletion')
  @RecentAuthentication()
  @AddressThrottle({ name: 'account-deletion', limit: 5, ttl: minutes(15) })
  @UserThrottle({ limit: 10, ttl: minutes(15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for your account to be deleted',
    description:
      'Carried out after ACCOUNT_DELETION_GRACE_DAYS unless cancelled; a mail says when, with a link that cancels without signing in. Wants a recent sign-in and, when the account has one (`hasPassword` of GET /v1/auth/me), your password. Every other session and token client is signed out; this one stays, to cancel. Asked again while one is pending: that one, unchanged. Records you created stay, without your name.',
  })
  @ApiOkResponse({ standardSchema: deletionSchema })
  @ApiBadRequestResponse({
    description: 'The password is missing (validation_failed).',
  })
  @ApiForbiddenResponse({
    description:
      'The password is wrong; or `reauthentication_required`; or acting as another user.',
  })
  requestDeletion(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord | undefined,
    @Body({ schema: requestDeletionSchema })
    body: z.infer<typeof requestDeletionSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.deletions.request(user, body.password, ip, session?.id);
  }

  @Delete('deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Keep your account: cancel the pending deletion' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'No deletion is pending.' })
  async cancelDeletion(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.deletions.cancel(user, ip);
  }

  @Get('consents')
  @ApiOperation({
    summary: 'What you agreed to: the latest version of each kind',
  })
  @ApiOkResponse({ standardSchema: listSchema(consentSchema) })
  async listConsents(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    return { items: await this.consents.latest(user.id) };
  }

  @Post('consents')
  @ApiOperation({
    summary: 'Record that you accept a version of the terms, a policy…',
    description:
      'A kind GET /v1/account/consent-kinds lists, at its current `version`. Every acceptance is kept. Audited (`account.consented`).',
  })
  @ApiCreatedResponse({ standardSchema: consentSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown kind, or another version than the current one (validation_failed).',
  })
  accept(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: acceptConsentSchema })
    body: z.infer<typeof acceptConsentSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.consents.accept(user, body.kind, body.version, ip);
  }

  @Delete('consents/:kind')
  @ApiOperation({
    summary: 'Withdraw a consent (marketing…)',
    description:
      'As easy as giving it. The acceptances stay, stamped with the withdrawal. Audited (`account.consent-withdrawn`).',
  })
  @ApiOkResponse({ standardSchema: consentSchema })
  @ApiNotFoundResponse({ description: 'Not given, or withdrawn already.' })
  @ApiConflictResponse({
    description:
      '`consent_required`: a required kind; delete the account instead.',
  })
  withdraw(
    @CurrentUser() user: UserPrincipal,
    @Param('kind') kind: string,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.consents.withdraw(user, kind, ip);
  }
}

/** The kinds of consent asked for here: for a sign-up page too, so public. They hold nothing about anyone. */
@ApiTags('account')
@Public()
@Controller('account/consent-kinds')
export class ConsentKindsController {
  constructor(private readonly kinds: ConsentKinds) {}

  @Get()
  @ApiOperation({
    summary: 'The kinds of consent asked for here, and their current version',
  })
  @ApiOkResponse({ standardSchema: listSchema(consentKindSchema) })
  list() {
    return { items: this.kinds.list() };
  }
}

/**
 * The deletion mail's cancel link, without a sign-in. The web app's page
 * (WEB_URL/cancel-deletion?token=…) POSTs the token here: a GET would let
 * a mail scanner cancel it. Every refusal is the same 400.
 */
@ApiTags('account')
@Public()
@Controller('account/deletion')
export class AccountDeletionLinkController {
  constructor(private readonly deletions: AccountDeletionService) {}

  @Post('cancel')
  @AddressThrottle({
    name: 'account-deletion-link',
    limit: 10,
    ttl: minutes(15),
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Keep your account: cancel the deletion with the mail's link",
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      'The link is invalid, expired or used, or the deletion was cancelled or carried out already: one answer for all.',
  })
  async cancel(
    @Body({ schema: cancelDeletionByLinkSchema })
    body: z.infer<typeof cancelDeletionByLinkSchema>,
    @Ip() ip: string,
  ) {
    await this.deletions.cancelByLink(body.token, ip);
  }
}

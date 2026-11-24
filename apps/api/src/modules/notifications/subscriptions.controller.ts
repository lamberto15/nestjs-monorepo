import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import { notWhileImpersonating } from './notifications.principals.js';
import { subscriptionPageSchema } from './notifications.schemas.js';
import { SUBSCRIPTION_LIST } from './subscriptions.lists.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * What the caller watches: start, list and end their subscriptions, for any
 * subject whose module registered a record finder (iam/access).
 */
@ApiTags('subscriptions')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The records you watch',
    description: 'Filter with `?subject=Note`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: subscriptionPageSchema })
  async list(
    @CurrentUser() user: Principal,
    @Query({ schema: SUBSCRIPTION_LIST.schema }) query: ListQuery,
  ) {
    return SUBSCRIPTION_LIST.pick(
      await this.subscriptions.page(user, query),
      query,
    );
  }

  @Put(':subject/:recordId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Watch a record',
    description:
      'Be told when it changes. Needs the permission to read it; a record you may not read, or that does not exist, is a 404. Watching again changes nothing.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  async watch(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    notWhileImpersonating(user);
    await this.subscriptions.watch(user, { subject, recordId });
  }

  @Delete(':subject/:recordId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'Stop watching a record' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'You were not watching it.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    notWhileImpersonating(user);
    await this.subscriptions.remove(user, { subject, recordId });
  }
}

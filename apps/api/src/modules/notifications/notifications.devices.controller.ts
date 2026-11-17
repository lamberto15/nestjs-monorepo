import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
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
import type { Principal } from '../../iam/auth/principal.js';
import { DevicesService } from './notifications.devices.service.js';
import { person } from './notifications.principals.js';
import { WebPush } from './notifications.push.js';
import {
  deviceListSchema,
  deviceSchema,
  type RegisterDeviceDto,
  registerDeviceSchema,
  webPushKeySchema,
} from './notifications.schemas.js';

/**
 * The browsers the caller registered for web push. A person's own: an API
 * client gets 403, and so does an administrator acting as the person.
 */
@ApiTags('devices')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({
  description: 'Only for people, and not while acting as another user.',
})
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly webPush: WebPush,
  ) {}

  @Get('web-push')
  @Can.Anyone()
  @ApiOperation({
    summary: 'The key a browser subscribes to web push with',
    description:
      'The VAPID public key (not a secret), or null while web push is off (`WEB_PUSH_SUBJECT` unset).',
  })
  @ApiOkResponse({ standardSchema: webPushKeySchema })
  async key() {
    return { publicKey: await this.webPush.publicKey() };
  }

  @Put()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Register this browser for web push, or refresh it',
    description:
      "Pass the browser's `PushSubscription` (`subscription.toJSON()`). Call it when the app opens: the last-seen time moves. A subscription another person had moves to you. Audited (`device.registered`).",
  })
  @ApiOkResponse({ standardSchema: deviceSchema })
  @ApiBadRequestResponse({ description: 'validation_failed.' })
  @ApiNotFoundResponse({ description: 'Web push is off (feature_off).' })
  register(
    @CurrentUser() user: Principal,
    @Body({ schema: registerDeviceSchema }) dto: RegisterDeviceDto,
    @Ip() ip: string,
  ) {
    const me = person(user);
    if (!this.webPush.enabled) {
      throw new NotFoundException({
        code: 'feature_off',
        message: 'Web push is off in this deployment.',
      });
    }
    return this.devices.register(me, dto, ip);
  }

  @Get()
  @Can.Anyone()
  @ApiOperation({ summary: 'Your registered browsers' })
  @ApiOkResponse({ standardSchema: deviceListSchema })
  list(@CurrentUser() user: Principal) {
    return this.devices.list(person(user));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Remove a registered browser',
    description: 'Deletes its subscription. Audited (`device.removed`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not yours, or gone.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.devices.remove(person(user), id, ip);
  }
}

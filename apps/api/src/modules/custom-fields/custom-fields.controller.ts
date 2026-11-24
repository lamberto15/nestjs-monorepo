import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
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
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { CustomFieldPolicy } from './custom-fields.policy.js';
import {
  type CreateCustomFieldDto,
  createCustomFieldSchema,
  type CustomFieldListQuery,
  customFieldListQuerySchema,
  customFieldListSchema,
  customFieldSchema,
  customFieldSubjectListSchema,
  customFieldSubjectsQuerySchema,
  type ReorderCustomFieldsDto,
  reorderCustomFieldsSchema,
  type UpdateCustomFieldDto,
  updateCustomFieldSchema,
} from './custom-fields.schemas.js';
import {
  customFieldView as view,
  CustomFieldsService,
} from './custom-fields.service.js';

/**
 * Custom fields: what administrators add to a record's subject at runtime,
 * without a migration. Reading a subject's fields takes reading the
 * subject; changing them takes Access.manageCustomFields.
 */
@ApiTags('custom fields')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get('subjects')
  @Can.Anyone() // Filtered by the service, by the same check as the list.
  @ApiOperation({
    summary: 'The subjects that take custom fields',
    description:
      'Only those whose fields you may read (whoever may read the subject, or manages custom fields); a 403 when there are none.',
  })
  @ApiOkResponse({ standardSchema: customFieldSubjectListSchema })
  subjects(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: customFieldSubjectsQuerySchema }) _query: unknown,
  ) {
    return this.fields.readableSubjects(user);
  }

  @Get()
  @Can.Anyone() // Checked by the service, on the subject.
  @ApiOperation({
    summary: "A subject's custom fields, in their order",
    description:
      "For anyone who may read the subject: forms and tables are built from them. Inactive fields only with includeInactive=true. ?include=counts adds how many records hold a value of each field (valueCount, and deletedValueCount for those in the recycle bin): one query over the subject's values, for those who manage custom fields only (403 otherwise).",
  })
  @ApiOkResponse({ standardSchema: customFieldListSchema })
  @ApiNotFoundResponse({ description: 'The subject takes no custom fields.' })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: customFieldListQuerySchema }) query: CustomFieldListQuery,
  ) {
    return this.fields.list(user, query);
  }

  @Post()
  @Can(CustomFieldPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Add a field to a subject',
    description:
      'Audited (customField.created). The key is set once and never reused.',
  })
  @ApiCreatedResponse({ standardSchema: customFieldSchema })
  @ApiBadRequestResponse({
    description:
      'An invalid definition: options, validation or a default the type does not take (validation_failed).',
  })
  @ApiNotFoundResponse({ description: 'The subject takes no custom fields.' })
  @ApiConflictResponse({
    description:
      'The key exists (custom_field_exists), or the subject has 100 active fields (custom_field_limit).',
  })
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createCustomFieldSchema }) body: CreateCustomFieldDto,
    @Ip() ip: string,
  ) {
    return view(await this.fields.create(user, body, ip));
  }

  @Put('order')
  @Can(CustomFieldPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: "Reorder a subject's fields",
    description:
      'The fields listed come first, in that order; the others follow in theirs. Audited (customField.reordered).',
  })
  @ApiOkResponse({ standardSchema: customFieldListSchema })
  async reorder(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: reorderCustomFieldsSchema }) body: ReorderCustomFieldsDto,
    @Ip() ip: string,
  ) {
    const items = await this.fields.reorder(user, body.subject, body.ids, ip);
    return { items: items.map(view) };
  }

  @Patch(':id')
  @Can(CustomFieldPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Change a field',
    description:
      'Audited with what changed (customField.updated). A type change is refused while records hold values (except text → longText, email/url → text or longText); so is removing a choice records hold.',
  })
  @ApiOkResponse({ standardSchema: customFieldSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      'Records hold values the change would break (custom_field_in_use).',
  })
  async update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateCustomFieldSchema }) body: UpdateCustomFieldDto,
    @Ip() ip: string,
  ) {
    return view(await this.fields.update(user, id, body, ip));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(CustomFieldPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Deactivate a field',
    description:
      'No longer accepted on writes nor shown; the values records hold are kept, and PATCH { active: true } brings it back.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async deactivate(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.fields.deactivate(user, id, ip);
  }
}

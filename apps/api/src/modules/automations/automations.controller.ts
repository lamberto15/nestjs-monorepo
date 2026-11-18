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
import type { ListQuery } from '../../core/http/list-query.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import {
  AUTOMATION_RULE_LIST,
  AUTOMATION_RUN_LIST,
} from './automations.lists.js';
import { AutomationRulePolicy } from './automations.policy.js';
import {
  automationRulePageSchema,
  automationRuleSchema,
  automationRunPageSchema,
  automationSimulationSchema,
  automationSubjectListSchema,
  type CreateAutomationRuleDto,
  createAutomationRuleSchema,
  type SimulateAutomationRuleDto,
  simulateAutomationRuleSchema,
  type UpdateAutomationRuleDto,
  updateAutomationRuleSchema,
} from './automations.schemas.js';
import { AutomationsService } from './automations.service.js';

const VALIDATION =
  'A subject that takes no rules, a field it lacks, a condition that does not compile (`condition`), an action it does not take or parameters it refuses (`actions.<n>`) (validation_failed).';

/**
 * Tenant automation rules (README.md): reading takes `AutomationRule.read`,
 * everything else `AutomationRule.configure` (users only, never while
 * impersonating). The policy lets only users through, so the principal is one.
 */
@ApiTags('automation-rules')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session.' })
@ApiForbiddenResponse({
  description:
    'Not allowed by your permissions, or a condition reads a field your permissions hide (field_forbidden).',
})
@Controller('automation-rules')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: 'The automation rules',
    description:
      '`?status=active`, `?subject=Invoice`, `?name.contains=`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: automationRulePageSchema })
  async list(@Query({ schema: AUTOMATION_RULE_LIST.schema }) query: ListQuery) {
    return AUTOMATION_RULE_LIST.pick(await this.automations.page(query), query);
  }

  @Get('subjects')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: 'What rules may be about',
    description:
      'The subjects that take rules: the fields a trigger may watch, what a condition may read, the actions each takes.',
  })
  @ApiOkResponse({ standardSchema: automationSubjectListSchema })
  subjects() {
    return { items: this.automations.subjects() };
  }

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Simulate a rule',
    description:
      'What a rule would do now, without doing it: the most recently changed records you may read (or `recordIds`), at most `limit` (50), those its condition holds for, each action checked under your permissions. No write, no notification, no webhook. A `field` trigger is not replayed (`triggerSimulated: false`).',
  })
  @ApiOkResponse({ standardSchema: automationSimulationSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  simulate(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: simulateAutomationRuleSchema })
    dto: SimulateAutomationRuleDto,
  ) {
    return this.automations.simulate(user, dto);
  }

  @Post()
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Create a rule',
    description:
      'A draft: it runs once activated. At most 5 actions. Audited (`automation-rule.created`).',
  })
  @ApiCreatedResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createAutomationRuleSchema }) dto: CreateAutomationRuleDto,
    @Ip() ip: string,
  ) {
    return this.automations.create(user, dto, ip);
  }

  @Get(':id')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({ summary: 'One automation rule' })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.automations.get(id);
  }

  @Patch(':id')
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Change a rule',
    description:
      'Only what is sent changes. A change of its trigger, condition or actions is a new `version`, and an active rule becomes a draft until activated again. Audited (`automation-rule.updated`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateAutomationRuleSchema }) dto: UpdateAutomationRuleDto,
    @Ip() ip: string,
  ) {
    return this.automations.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Delete a rule',
    description: 'With its runs. Audited (`automation-rule.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.automations.remove(user, id, ip);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Activate a rule',
    description:
      'It runs from now on, as you, with your permissions as they are at each run (checked again now). At most 20 active rules. Audited (`automation-rule.activated`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiConflictResponse({ description: 'Active already (automation_active).' })
  @ApiNotFoundResponse()
  activate(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.automations.activate(user, id, ip);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'configure')
  @ApiOperation({
    summary: 'Disable a rule',
    description:
      'It stops at once: runs already queued do nothing. Audited (`automation-rule.disabled`, reason `manual`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiNotFoundResponse()
  disable(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.automations.disable(user, id, ip);
  }

  @Get(':id/runs')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: "A rule's runs",
    description:
      'What each run did, or why it failed (`?status=failed`, `?recordId=`); newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: automationRunPageSchema })
  @ApiNotFoundResponse()
  async runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: AUTOMATION_RUN_LIST.schema }) query: ListQuery,
  ) {
    return AUTOMATION_RUN_LIST.pick(
      await this.automations.runs(id, query),
      query,
    );
  }
}

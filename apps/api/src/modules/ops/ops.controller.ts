import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type Observable, map } from 'rxjs';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { OpsActions } from './ops.actions.js';
import { OpsBacklog } from './ops.backlog.js';
import { OpsDiagnostics } from './ops.diagnostics.js';
import { OpsEventStream } from './ops.events.js';
import { opsEventSchema } from './ops.events.schemas.js';
import { z } from 'zod';
import { OpsPolicy } from './ops.policy.js';
import {
  type BacklogAction,
  backlogActionSchema,
  backlogPreviewSchema,
  backlogResultSchema,
  backlogScopeSchema,
  type DeadLetterQuery,
  deadLetterListSchema,
  deadLetterQuerySchema,
  type DeadLettersTarget,
  deadLettersTargetSchema,
  diagnosticsSchema,
  diagnosticTestSchema,
  discardedSchema,
  jobListSchema,
  type JobsQuery,
  jobsQuerySchema,
  outboxSchema,
  pausedSchema,
  queueListSchema,
  retriedSchema,
  workflowListSchema,
  type WorkflowsQuery,
  workflowsQuerySchema,
  workflowSchema,
} from './ops.schemas.js';
import { OpsService } from './ops.service.js';

/**
 * The operators' view of the background work, every tenant's together: the
 * queues and their jobs, the outbox and its dead letters, the workflows.
 * Operators only (`@OperatorOnly()`: members of OPERATOR_TENANT), on top of
 * the `Access` actions of ops.permissions.ts. What changes is audited in
 * the operators' tenant.
 */
@ApiTags('ops')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({
  description: 'Not an operator, or not allowed by your permissions.',
})
@UserOnly()
@OperatorOnly()
@AllowInMaintenance()
@Controller('ops')
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly actions: OpsActions,
    private readonly backlog: OpsBacklog,
    private readonly diagnostics: OpsDiagnostics,
    private readonly events: OpsEventStream,
  ) {}

  @Get('queues')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary: 'The background queues: counts by state, paused, workers',
  })
  @ApiOkResponse({ standardSchema: queueListSchema })
  async queues() {
    return { items: await this.ops.queueStates() };
  }

  @Get('queues/:name/jobs')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary: "A queue's latest jobs in a state (failed by default)",
    description:
      'Metadata only, never a payload. A failure reason is masked as in the logs and cut.',
  })
  @ApiOkResponse({ standardSchema: jobListSchema })
  @ApiNotFoundResponse({ description: 'queue_not_found.' })
  async jobs(
    @Param('name') name: string,
    @Query({ schema: jobsQuerySchema }) query: JobsQuery,
  ) {
    return { items: await this.ops.jobs(name, query) };
  }

  @Post('queues/:name/pause')
  @Can(OpsPolicy, 'pauseQueues')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause a queue (every worker stops taking its jobs)',
    description:
      'Kept in Redis: nothing is lost and running jobs finish. Audited.',
  })
  @ApiOkResponse({ standardSchema: pausedSchema })
  @ApiNotFoundResponse({ description: 'queue_not_found.' })
  pause(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    return this.actions.pause(user, name, ip);
  }

  @Post('queues/:name/resume')
  @Can(OpsPolicy, 'pauseQueues')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a paused queue. Audited.' })
  @ApiOkResponse({ standardSchema: pausedSchema })
  @ApiNotFoundResponse({ description: 'queue_not_found.' })
  resume(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    return this.actions.resume(user, name, ip);
  }

  @Post('queues/:name/retry-failed')
  @Can(OpsPolicy, 'retryJobs')
  @HttpCode(200)
  @ApiOperation({ summary: "Run a queue's failed jobs again. Audited." })
  @ApiOkResponse({ standardSchema: retriedSchema })
  @ApiNotFoundResponse({ description: 'queue_not_found.' })
  retryFailed(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    return this.actions.retryFailed(user, name, ip);
  }

  @Get('outbox')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary: 'The outbox: messages waiting, dead letters, and the lag',
    description:
      'lagMs is the number to alert on: how long the longest-waiting message has waited.',
  })
  @ApiOkResponse({ standardSchema: outboxSchema })
  outbox() {
    return this.ops.outbox();
  }

  @Get('dead-letters')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary: 'The messages the outbox gave up on, newest first',
    description:
      'Metadata only, never a payload. The last error is masked as in the logs and cut.',
  })
  @ApiOkResponse({ standardSchema: deadLetterListSchema })
  async deadLetters(
    @Query({ schema: deadLetterQuerySchema }) query: DeadLetterQuery,
  ) {
    return { items: await this.ops.listDeadLetters(query) };
  }

  @Post('dead-letters/retry')
  @Can(OpsPolicy, 'retryJobs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Retry dead letters (these ids, or all when none is given)',
    description:
      'They go back to the outbox with a fresh retry budget and the same id, so consumers still recognise them. Audited.',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  retryDeadLetters(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: deadLettersTargetSchema }) body: DeadLettersTarget,
    @Ip() ip: string,
  ) {
    return this.actions.retryDeadLetters(user, body, ip);
  }

  @Post('dead-letters/discard')
  @Can(OpsPolicy, 'discardJobs')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Delete dead letters for good (these ids, or all when none is given)',
    description: 'Audited.',
  })
  @ApiOkResponse({ standardSchema: discardedSchema })
  discardDeadLetters(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: deadLettersTargetSchema }) body: DeadLettersTarget,
    @Ip() ip: string,
  ) {
    return this.actions.discardDeadLetters(user, body, ip);
  }

  @Get('diagnostics')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary: 'The integrations: database, Redis, workers, mail, storage…',
    description:
      'Each one ok (answered now), configured (set up; a check that does something, like mail or storage, runs only on its test route) or unavailable. A module adds its own with `@Diagnostic()`. A driver is a name, never a URL or a credential; errors are masked as in the logs and cut.',
  })
  @ApiOkResponse({ standardSchema: diagnosticsSchema })
  async diagnosticsOverview() {
    return { items: await this.diagnostics.overview() };
  }

  @Post('diagnostics/:check/test')
  @Can(OpsPolicy, 'testIntegrations')
  @UserThrottle({ limit: 10, ttl: 60_000 })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test one integration now (safe: sends nothing, keeps nothing)',
    description:
      'SMTP connects, authenticates and says QUIT; storage writes, reads and deletes a probe file. A failure answers 200 with ok false and the masked reason. 400 not_testable when the configuration has nothing safe to probe. 10 a minute per user. Audited.',
  })
  @ApiOkResponse({ standardSchema: diagnosticTestSchema })
  @ApiNotFoundResponse({ description: 'diagnostic_not_found.' })
  testDiagnostic(
    @CurrentUser() user: UserPrincipal,
    @Param('check') check: string,
    @Ip() ip: string,
  ) {
    return this.actions.testDiagnostic(user, check, ip);
  }

  @Sse('events')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({
    summary:
      'Live events of workflows, webhooks, the outbox, idempotency, locks, mail and resilience (Server-Sent Events)',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description:
      'A stream of `data: {source, at, type, …}` messages, each one JSON. Errors are masked as in the logs and cut; no stack traces, payloads or headers.',
    standardSchema: opsEventSchema,
  })
  eventStream(): Observable<{ data: unknown }> {
    return this.events.stream().pipe(map((data) => ({ data })));
  }

  @Post('backlog/preview')
  @Can(OpsPolicy, 'viewOps')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Count the outbox and mail backlog of one tenant, or of every tenant',
    description:
      'Changes nothing. Exactly one of tenantId and global: true. topic narrows the outbox, template the mail queue, before (ISO 8601) keeps to older work. Mail jobs name no tenant, so a tenant scope counts the outbox only.',
  })
  @ApiOkResponse({ standardSchema: backlogPreviewSchema })
  previewBacklog(
    @Body({ schema: backlogScopeSchema })
    scope: z.infer<typeof backlogScopeSchema>,
  ) {
    return this.backlog.preview(scope);
  }

  @Post('backlog/discard')
  @Can(OpsPolicy, 'discardJobs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Discard the outbox or mail backlog in a scope',
    description:
      'outbox: deletes pending messages not being delivered, and dead letters. mail: removes waiting, delayed and failed jobs, never essential mail or running work. Up to limit (10,000) per call: call again while more. Preview first. Audited.',
  })
  @ApiOkResponse({ standardSchema: backlogResultSchema })
  discardBacklog(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: backlogActionSchema }) body: BacklogAction,
    @Ip() ip: string,
  ) {
    return this.actions.discardBacklog(user, body, ip);
  }

  @Post('backlog/retry')
  @Can(OpsPolicy, 'retryJobs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Retry the outbox dead letters or failed mail in a scope',
    description:
      'outbox: requeues the dead letters with a fresh retry budget; mail: retries the failed jobs. Up to limit (10,000) per call: call again while more. Audited.',
  })
  @ApiOkResponse({ standardSchema: backlogResultSchema })
  retryBacklog(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: backlogActionSchema }) body: BacklogAction,
    @Ip() ip: string,
  ) {
    return this.actions.retryBacklog(user, body, ip);
  }

  @Get('workflows')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({ summary: 'Workflow instances, oldest first' })
  @ApiOkResponse({ standardSchema: workflowListSchema })
  async workflows(
    @Query({ schema: workflowsQuerySchema }) query: WorkflowsQuery,
  ) {
    return { items: await this.ops.listWorkflows(query) };
  }

  @Get('workflows/:id')
  @Can(OpsPolicy, 'viewOps')
  @ApiOperation({ summary: 'One workflow instance' })
  @ApiOkResponse({ standardSchema: workflowSchema })
  @ApiNotFoundResponse({ description: 'workflow_not_found.' })
  workflow(@Param('id') id: string) {
    return this.ops.workflow(id);
  }

  @Post('workflows/:id/retry')
  @Can(OpsPolicy, 'retryJobs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a failed workflow again from its journal',
    description:
      'Completed steps return their results; the steps that gave up get their attempts back. Audited.',
  })
  @ApiOkResponse({ standardSchema: workflowSchema })
  @ApiNotFoundResponse({ description: 'workflow_not_found.' })
  @ApiConflictResponse({ description: 'workflow_not_retryable: not failed.' })
  retryWorkflow(
    @CurrentUser() user: UserPrincipal,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.actions.retryWorkflow(user, id, ip);
  }
}

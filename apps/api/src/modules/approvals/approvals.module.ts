import {
  Body,
  type DynamicModule,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import type { NodeResponse } from '@nestjs/platform-node';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { queuesConfig } from '../../core/queues/queues.config.js';
import {
  ACCESS_EVENTS,
  type MemberDeactivatedEvent,
} from '../../iam/access/access.events.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordIdempotent } from '../records/record.routes.js';
import { RecordsModule } from '../records/records.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { Records } from '../records/records.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  ApprovalDelegationsController,
  ApprovalPoliciesController,
} from './approval-admin.controllers.js';
import { ApprovalDelegationsService } from './approval-delegations.service.js';
import { ApprovalEngine } from './approval-engine.service.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import { ApprovalWorkflow } from './approval.workflow.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalMetrics } from './approvals.metrics.js';
import {
  APPROVAL_EVENTS,
  APPROVAL_NOTIFICATIONS,
  approvalWebhookData,
} from './approvals.events.js';
import { ApprovalInboxSource } from './approvals.inbox.js';
import { APPROVAL_PERMISSIONS } from './approvals.permissions.js';
import { ApprovalsPolicy } from './approvals.policy.js';
import {
  actionPath,
  ApprovalRegistration,
  ApprovalsRegistry,
  type RecordApproval,
} from './approvals.registry.js';
import {
  actionResultSchema,
  requestActionSchema,
} from './approvals.schemas.js';
import { ApprovalsService } from './approvals.service.js';
import { APPROVAL_SETTINGS } from './approvals.settings.js';
import { Approvers } from './approvers.js';
import { ApprovalsPersonalData } from './approvals.personal-data.js';

/**
 * A deactivated member decides nothing more: their pending assignments
 * close (their stages settle again) and their delegations end, in the
 * deactivation's transaction, as the administrator who did it.
 */
@Injectable()
export class ApprovalsDeactivation {
  constructor(private readonly engine: ApprovalEngine) {}

  @OnEvent(ACCESS_EVENTS.memberDeactivated, { suppressErrors: false })
  async deactivated(event: MemberDeactivatedEvent) {
    await this.engine.release(event.userId, event.actor);
  }
}

/**
 * What approvals add to a record's writes: while a request waits for a
 * decision (or its approved outcome isn't applied yet), the record can't be
 * changed or deleted (409 `approval_pending`); deleting it withdraws its
 * requests sent back for changes; deleting it for good removes them.
 */
@RecordExtension()
@Injectable()
export class ApprovalsExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly approvals: ApprovalsService,
  ) {}

  async updating({ before }: { before: Record<string, unknown> }) {
    await this.approvals.assertNotPending(
      this.record.subject,
      before.id as string,
    );
  }

  async deleting({ row, by }: { row: Record<string, unknown>; by: Principal }) {
    await this.approvals.assertNotPending(
      this.record.subject,
      row.id as string,
    );
    await this.approvals.withdraw(by, this.record.subject, row.id as string);
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.approvals.forget(this.record.subject, ids);
  }
}

/**
 * Approvals (README.md): the `/v1/approvals` routes, the requests'
 * workflow, delegations and policies, shared by every record with
 * approvable actions. A feature's module imports
 * `ApprovalsModule.forRecord(RECORD, { publish: { label } })` and provides
 * the effect of each action (`@ApprovalEffect({ subject: 'Invoice', action: 'publish' })`).
 */
@Module({
  imports: [
    AccessModule.forFeature(APPROVAL_PERMISSIONS),
    AuditModule,
    ConfigModule.forFeature(queuesConfig),
    DiscoveryModule,
    MetricsModule,
    NotificationsModule,
    NotificationsModule.forFeature(APPROVAL_NOTIFICATIONS),
    OrganizationModule,
    RealtimeModule,
    RecordsModule,
    SettingsModule.forFeature(APPROVAL_SETTINGS),
    // To the API client that made the request, and to no other.
    WebhooksModule.forFeature(
      (
        [
          ['requested', 'was made'],
          ['approved', 'was approved'],
          ['rejected', 'was rejected'],
          ['changes_requested', 'came back with changes requested'],
          ['cancelled', 'was cancelled'],
          ['expired', 'expired'],
          ['failed', 'failed'],
        ] as const
      ).map(([name, what]) => ({
        event: APPROVAL_EVENTS[name],
        subject: 'Approval',
        description: `An approval request of this client ${what}.`,
        data: approvalWebhookData,
        to: (payload: { clientId?: string }) => payload.clientId,
      })),
    ),
  ],
  controllers: [
    // Before ApprovalsController: its /approvals/{id} would read `delegations` as an id.
    ApprovalDelegationsController,
    ApprovalPoliciesController,
    ApprovalsController,
  ],
  providers: [
    ApprovalsRegistry,
    Approvers,
    ApprovalEngine,
    ApprovalWorkflow,
    ApprovalsService,
    ApprovalPoliciesService,
    ApprovalDelegationsService,
    ApprovalsPolicy,
    ApprovalInboxSource,
    ApprovalsDeactivation,
    ApprovalsPersonalData,
    ApprovalMetrics,
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {
  /** Approvable actions of one record: a route each, their flags, and the extension. */
  static forRecord(
    record: RecordDeclaration,
    actions: Record<string, RecordApproval>,
  ): DynamicModule {
    const registration = new ApprovalRegistration(record, actions);
    const flags = registration.actions.flatMap((a) => (a.flag ? [a.flag] : []));
    return {
      module: ApprovalsRecordModule,
      imports: [
        RecordsModule,
        ApprovalsModule,
        SettingsModule.forFeature(flags),
      ],
      controllers: registration.actions.map((declared) =>
        actionRoute(record, declared.action, declared.approval),
      ),
      providers: [
        { provide: RECORD, useValue: record },
        { provide: ApprovalRegistration, useValue: registration },
        ApprovalsExtension,
      ],
    };
  }
}

/** The host of one `ApprovalsModule.forRecord()`. */
@Module({})
class ApprovalsRecordModule {}

/**
 * `POST /<path>/{id}/<action>`: asks for the approval the policy needs, or
 * applies the action at once when none is needed. 200 `applied`, 202
 * `pending`. Whoever may update the record may ask.
 */
function actionRoute(
  record: RecordDeclaration,
  action: string,
  approval: RecordApproval,
): Type {
  const suffix = `${action[0]!.toUpperCase()}${action.slice(1)}Approval`;

  @RecordController(record, `:id/${actionPath(action)}`, suffix)
  class ApprovalActionRoute {
    constructor(
      private readonly records: Records,
      private readonly authorization: AuthorizationService,
      private readonly approvals: ApprovalsService,
    ) {}

    @Post()
    @HttpCode(HttpStatus.OK)
    @RecordIdempotent(record)
    @Can.Anyone() // Checked below: updating the record.
    @ApiOperation({
      summary: approval.label,
      description: `Needs the approval of ${record.subject}.${action}'s policy when it is on for you (GET /v1/approvals/policies/${record.subject}.${action}); otherwise it is done at once. While a request is open, ${aNoun(record)} can't be changed or deleted (409 \`approval_pending\`).`,
    })
    @ApiOkResponse({
      standardSchema: actionResultSchema,
      description: 'No approval was needed: it is done.',
    })
    @ApiAcceptedResponse({
      standardSchema: actionResultSchema,
      description: 'Waiting for the approvers: GET /v1/approvals/{approvalId}.',
    })
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    @ApiNotFoundResponse({ description: `No such ${record.noun}.` })
    @ApiConflictResponse({
      description:
        'An approval of this action is already open (approval_pending).',
    })
    @ApiUnprocessableEntityResponse({
      description: 'A stage would find no approver (approval_no_approvers).',
    })
    async request(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: requestActionSchema }) dto: { comment?: string },
      @Ip() ip: string,
      @Res({ passthrough: true }) res: NodeResponse,
    ) {
      const { store, feature } = this.records.of(record.subject);
      // Unreadable: the 404 of a missing one; readable but not theirs to change: a 403.
      const row = await store.findOne(id, { visibleTo: user });
      await this.authorization.authorize(
        feature.policy as unknown as Type<{
          update(...args: unknown[]): boolean;
        }>,
        'update',
        user,
        row,
      );
      const result = await this.approvals.act(
        user,
        record.subject,
        id,
        action,
        dto.comment,
        ip,
      );
      if (result.status === 'pending') res.status(HttpStatus.ACCEPTED);
      return result;
    }
  }
  return ApprovalActionRoute;
}

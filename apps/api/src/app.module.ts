import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from './core/database/database.module.js';
import { EncryptionModule } from './core/encryption/encryption.module.js';
import { HealthModule } from './core/health/health.module.js';
import { SharedHttpClientModule } from './core/http-client/http-client.module.js';
import { HttpConventionsModule } from './core/http/http-conventions.module.js';
import { I18nModule } from './core/i18n/i18n.module.js';
import { SharedIdempotencyModule } from './core/idempotency/idempotency.module.js';
import { JobsModule } from './core/jobs/jobs.module.js';
import { SharedLocksModule } from './core/locks/locks.module.js';
import { LoggingModule } from './core/logging/logging.module.js';
import { MailModule } from './core/mail/mail.module.js';
import { MetricsModule } from './core/metrics/metrics.module.js';
import { ObservabilityModule } from './core/observability/observability.module.js';
import { SharedOutboxModule } from './core/outbox/outbox.module.js';
import { QueuesModule } from './core/queues/queues.module.js';
import { RedisModule } from './core/redis/redis.module.js';
import { SecretsModule } from './core/secrets/secrets.module.js';
import { TenancyModule } from './core/tenancy/tenancy.module.js';
import { ThrottlingModule } from './core/throttling/throttling.module.js';
import { WebModule } from './core/web/web.module.js';
import { SharedWorkflowsModule } from './core/workflows/workflows.module.js';
import { AccessModule } from './iam/access/access.module.js';
import { AuditLogModule } from './iam/audit-log/audit-log.module.js';
import { AuthPolicyModule } from './iam/auth-policy/auth-policy.module.js';
import { PersonalDataModule } from './iam/personal-data/personal-data.module.js';
import { AcknowledgmentsModule } from './modules/acknowledgments/acknowledgments.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { AvatarsModule } from './modules/attachments/avatars/avatars.module.js';
import { AutomationsModule } from './modules/automations/automations.module.js';
import { BrandingModule } from './modules/branding/branding.module.js';
import { BulkRunsModule } from './modules/bulk/bulk.module.js';
import { ChoicesModule } from './modules/choices/choices.module.js';
import { ConfigBundlesModule } from './modules/config-bundles/config-bundles.module.js';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module.js';
import { DataQualityModule } from './modules/data-quality/data-quality.module.js';
import { AccountExportsModule } from './modules/data-transfer/account-exports.module.js';
import { DataTransferModule } from './modules/data-transfer/data-transfer.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { EncryptionAdminModule } from './modules/encryption-admin/encryption-admin.module.js';
import { FavoritesModule } from './modules/favorites/favorites.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { PeopleModule } from './modules/people/people.module.js';
import { RecentsModule } from './modules/recents/recents.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { SharesModule } from './modules/shares/shares.module.js';
import { TagsModule } from './modules/tags/tags.module.js';
import { TemplatesModule } from './modules/templates/templates.module.js';
import { ViewsModule } from './modules/views/views.module.js';
import { AccountModule } from './iam/account/account.module.js';
import { ApiClientsModule } from './iam/api-clients/api-clients.module.js';
import { AuditModule } from './iam/audit/audit.module.js';
import { AuthModule } from './iam/auth/auth.module.js';
import { BreakGlassModule } from './iam/break-glass/break-glass.module.js';
import { CaptchaModule } from './iam/captcha/captcha.module.js';
import { HoldsModule } from './iam/holds/holds.module.js';
import { ImpersonationModule } from './iam/impersonation/impersonation.module.js';
import { InvitationsModule } from './iam/invitations/invitations.module.js';
import { OrganizationModule } from './iam/organization/organization.module.js';
import { SsoModule } from './iam/sso/sso.module.js';
import { TenantsModule } from './iam/tenants/tenants.module.js';
import { CalendarsModule } from './modules/calendars/calendars.module.js';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module.js';
import { DeliverabilityModule } from './modules/deliverability/deliverability.module.js';
import { FeaturesModule } from './modules/features/features.module.js';
import { FormsModule } from './modules/forms/forms.module.js';
import { ImagesModule } from './modules/images/images.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { ListsModule } from './modules/lists/lists.module.js';
import { McpModule } from './modules/mcp/mcp.module.js';
import { MessagingModule } from './modules/messaging/messaging.module.js';
import { ModeModule } from './modules/mode/mode.module.js';
import { MoneyModule } from './modules/money/money.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PresenceModule } from './modules/presence/presence.module.js';
import { QuotasModule } from './modules/quotas/quotas.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RecurrenceModule } from './modules/recurrence/recurrence.module.js';
import { RetentionModule } from './modules/retention/retention.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { SequencesModule } from './modules/sequences/sequences.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { UsageModule } from './modules/usage/usage.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

/**
 * Every module of the app, listed here and nowhere else. A module owns its
 * routes, tables, environment variables and tests, so removing one is
 * deleting its folder and its line below (AGENTS.md, "Rules").
 */
@Module({
  imports: [
    // Loads .env into process.env; each module reads and checks its own
    // variables in its *.config.ts.
    ConfigModule.forRoot(),
    // Before every other module, so the APM sees all of them (NestJS Observe's
    // docs: first in the imports; .env is already loaded by then).
    ObservabilityModule,
    // Events inside the process: how modules of one level talk.
    EventEmitterModule.forRoot(),
    // Core: always there.
    LoggingModule,
    MetricsModule,
    HttpConventionsModule,
    ThrottlingModule,
    I18nModule,
    DatabaseModule,
    TenancyModule,
    RedisModule,
    QueuesModule,
    SharedLocksModule,
    EncryptionModule,
    SecretsModule,
    MailModule,
    HealthModule,
    SharedOutboxModule,
    SharedWorkflowsModule,
    JobsModule,
    // The built web app, on every path the API doesn't own (WEB_ROOT).
    WebModule,
    // Global interceptors and guards run in the order their modules are
    // first reached, so this block's order matters.
    // Interceptors: idempotency comes before every one that does work (a
    // replayed response is neither metered nor retried), then usage
    // metering, and the retries of outbound calls are the innermost. Only
    // the two that set a request's context (its language, I18nModule;
    // nestjs-cls) and the trace around everything (ObservabilityModule)
    // stay outside idempotency: its boot warning names them, and
    // app.module.e2e-spec.ts fails when another one joins.
    // Guards: the rate limit (ThrottlingModule, above), then who is calling
    // (AuthModule), then what they may do (AccessModule, which refuses a
    // route that declares no check: @Can(), @Can.Anyone() or @Public()).
    // AuthModule therefore comes before every module that imports
    // AccessModule, as UsageModule does.
    SharedIdempotencyModule,
    AuthModule,
    AuditModule,
    AccessModule,
    UsageModule,
    SharedHttpClientModule,
    // The rest of identity and access.
    OrganizationModule,
    CaptchaModule,
    // Its guard ("SSO required") runs after the principal's.
    SsoModule,
    AccountModule,
    ApiClientsModule,
    InvitationsModule,
    TenantsModule,
    ImpersonationModule,
    BreakGlassModule,
    HoldsModule,
    AuditLogModule,
    AuthPolicyModule,
    PersonalDataModule,
    // Optional capabilities. One may use what another exports, in one
    // direction only (AGENTS.md, "Rules"); the one used comes first.
    SettingsModule,
    // Its guard refuses writes while APP_MODE says so.
    ModeModule,
    FeaturesModule,
    QuotasModule,
    StorageModule,
    ImagesModule,
    ClientErrorsModule,
    RealtimeModule,
    PresenceModule,
    NotificationsModule,
    InboxModule,
    WebhooksModule,
    DeliverabilityModule,
    MessagingModule,
    MoneyModule,
    SequencesModule,
    CalendarsModule,
    RecurrenceModule,
    RetentionModule,
    ListsModule,
    SearchModule,
    PeopleModule,
    BrandingModule,
    ConfigBundlesModule,
    AiModule,
    AutomationsModule,
    OpsModule,
    EncryptionAdminModule,
    // What a record can also have. A feature takes one with
    // `XModule.forRecord(DECLARATION)` in its own module; listed here are
    // the routes these have of their own (the tags, a person's favorites…).
    TagsModule,
    FavoritesModule,
    RecentsModule,
    ViewsModule,
    TemplatesModule,
    ChoicesModule,
    SharesModule,
    CustomFieldsModule,
    AttachmentsModule,
    AvatarsModule,
    DocumentsModule,
    BulkRunsModule,
    DataTransferModule,
    AccountExportsModule,
    ReportsModule,
    DataQualityModule,
    ApprovalsModule,
    AcknowledgmentsModule,
    // Runtime forms and their submissions.
    FormsModule,
    // Tools for AI agents, with the caller's own permissions.
    McpModule,
  ],
})
export class AppModule {}

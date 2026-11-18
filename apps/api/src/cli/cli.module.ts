import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { AccessModule } from '../iam/access/access.module.js';
import { AccountModule } from '../iam/account/account.module.js';
import { AuditModule } from '../iam/audit/audit.module.js';
import { TenantsModule } from '../iam/tenants/tenants.module.js';
import { EncryptionAdminModule } from '../modules/encryption-admin/encryption-admin.module.js';
import { OpsModule } from '../modules/ops/ops.module.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { SettingsModule } from '../modules/settings/settings.module.js';
import { TenantMoveModule } from '../modules/tenant-move/tenant-move.module.js';
import { Accounts } from './accounts.service.js';
import { CLI_PERMISSIONS } from './cli.jobs.js';
import { COMMANDS } from './commands.js';
import { ConfirmQuestions, Confirmer } from './confirm.js';
import { Operations } from './operations.service.js';
import { TENANT_MOVE_PROVIDERS } from './tenant-move.commands.js';

/**
 * The app plus the operator commands: what `pnpm ops` boots (run.ts), never
 * the API or the worker. It imports the modules whose services the
 * commands call (AccountModule, TenantsModule, TenantMoveModule), so it works whether or not app.module.ts lists them.
 */
@Module({
  imports: [
    AppModule,
    AccessModule.forFeature(CLI_PERMISSIONS),
    AuditModule,
    AccountModule,
    TenantsModule,
    OpsModule,
    SettingsModule,
    NotificationsModule,
    EncryptionAdminModule,
    TenantMoveModule,
  ],
  providers: [
    Accounts,
    Operations,
    Confirmer,
    ConfirmQuestions,
    ...COMMANDS,
    ...TENANT_MOVE_PROVIDERS,
  ],
})
export class CliModule {}

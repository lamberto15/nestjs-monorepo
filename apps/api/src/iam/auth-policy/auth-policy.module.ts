import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { accountConfig } from '../account/account.config.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { AuthPolicyController } from './auth-policy.controller.js';
import { AUTH_POLICY_PERMISSIONS } from './auth-policy.permissions.js';
import { AuthPolicyPolicy } from './auth-policy.policy.js';
import { TenantAuthPolicies } from './auth-policy.service.js';

/**
 * The tenants' sign-in policies (README.md): the routes under
 * /access/auth-policy, and the `@AuthPolicySource()` iam/auth applies.
 * Needs AuthModule (global), AccessModule and the database.
 */
@Module({
  imports: [
    AccessModule.forFeature(AUTH_POLICY_PERMISSIONS),
    AuditModule,
    // A unit's requirement reaches the units below it.
    OrganizationModule,
    // AUTH_MFA: two-factor can't be required where nobody can enrol.
    ConfigModule.forFeature(accountConfig),
  ],
  controllers: [AuthPolicyController],
  providers: [TenantAuthPolicies, AuthPolicyPolicy],
})
export class AuthPolicyModule {}

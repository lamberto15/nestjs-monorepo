import { Resolver } from 'node:dns/promises';
import { BullModule } from '@nestjs/bullmq';
import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { csrfExclusions } from '../../core/http/http-setup.js';
import { httpConfig } from '../../core/http/http.config.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { authConfig } from '../auth/auth.config.js';
import { Oauth2Sso } from './oauth2-sso.service.js';
import { OidcSso } from './oidc-sso.service.js';
import { SamlMetadataImport } from './saml-metadata.service.js';
import { SamlSso } from './saml-sso.service.js';
import { ScimGroupsService } from './scim/scim-groups.service.js';
import { ScimUsersService } from './scim/scim-users.service.js';
import { ScimController } from './scim/scim.controller.js';
import { SsoSignIn } from './sso-sign-in.service.js';
import { SsoAccounts } from './sso-accounts.service.js';
import {
  SsoAuthController,
  SsoConnectionGuard,
} from './sso-auth.controller.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDiscoveryController } from './sso-discovery.controller.js';
import { SsoDiscovery } from './sso-discovery.service.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { SsoPolicyService } from './sso-policy.service.js';
import { SsoRequiredGuard } from './sso-required.guard.js';
import { ssoConfig } from './sso.config.js';
import { SsoController } from './sso.controller.js';
import { SSO_PERMISSIONS } from './sso.permissions.js';
import { SsoPolicy } from './sso.policy.js';
import { SsoDomainsCheckJob, SsoProcessor } from './sso.processor.js';
import { SSO_QUEUE, SSO_TXT_RESOLVER } from './sso.queue.js';

// The identity provider's page posts the SAML response from its own site:
// the assertion's signature, audience and InResponseTo are what authenticate it.
csrfExclusions.set('sso.saml-acs', {
  path: 'auth/sso/:tenantId/:connectionId/saml/acs',
  method: RequestMethod.POST,
  version: '1',
});

/**
 * Enterprise sign-on (README.md): a tenant's OIDC, SAML and OAuth 2.0
 * connections, its verified domains, "SSO required" (a global guard) and
 * SCIM 2.0 provisioning. List it after AccessModule and OrganizationModule
 * (its guard runs after the principal's); it needs QueuesModule, and
 * AuthModule's SignInService (global).
 */
@Module({
  imports: [
    ConfigModule.forFeature(ssoConfig),
    ConfigModule.forFeature(httpConfig),
    ConfigModule.forFeature(authConfig),
    AccessModule.forFeature(SSO_PERMISSIONS),
    AuditModule,
    BullModule.registerQueue({
      name: SSO_QUEUE,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [
    SsoController,
    SsoDiscoveryController,
    SsoAuthController,
    ScimController,
  ],
  providers: [
    SsoPolicy,
    SsoConnectionsService,
    SsoDomainsService,
    SsoPolicyService,
    SsoDiscovery,
    SsoAccounts,
    SsoSignIn,
    OidcSso,
    Oauth2Sso,
    SamlSso,
    SamlMetadataImport,
    SsoConnectionGuard,
    SsoProcessor,
    SsoDomainsCheckJob,
    ScimUsersService,
    ScimGroupsService,
    // The domains' TXT lookups: the system resolver, bounded; tests replace it.
    {
      provide: SSO_TXT_RESOLVER,
      useFactory: () => new Resolver({ timeout: 5000, tries: 2 }),
    },
    SsoRequiredGuard,
    { provide: APP_GUARD, useExisting: SsoRequiredGuard },
  ],
  exports: [SsoPolicyService],
})
export class SsoModule {}

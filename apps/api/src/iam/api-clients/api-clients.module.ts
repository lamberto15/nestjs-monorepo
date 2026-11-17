import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { authConfig } from '../auth/auth.config.js';
import { ApiClientsController } from './api-clients.controller.js';
import { API_CLIENT_PERMISSIONS } from './api-clients.permissions.js';
import { ApiClientPolicy } from './api-clients.policy.js';
import { ApiClientsService } from './api-clients.service.js';

/**
 * The tenant's API clients and their keys (README.md): the routes under
 * /access/clients, and the events that end a client's or a key's sockets.
 * What lets a key in is iam/auth's; the tables are auth's and access's.
 * Imports AccessModule; access never imports it.
 */
@Module({
  imports: [
    AccessModule.forFeature(API_CLIENT_PERMISSIONS),
    AuditModule,
    // The API_CLIENTS switch (auth.apiClients) the controller's guard reads.
    ConfigModule.forFeature(authConfig),
  ],
  controllers: [ApiClientsController],
  providers: [ApiClientsService, ApiClientPolicy],
  exports: [ApiClientsService],
})
export class ApiClientsModule {}

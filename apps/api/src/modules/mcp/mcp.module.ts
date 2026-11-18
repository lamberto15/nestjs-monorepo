import { type DynamicModule, Module, UseGuards } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Can } from '@nestjs/authorization';
import { McpModule as McpServerModule } from '@nestjs/mcp';
import { AccessModule } from '../../iam/access/access.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { RECORD } from '../records/record-extension.js';
import type { RecordDeclaration } from '../records/record.js';
import { RecordsModule } from '../records/records.module.js';
import { idempotencyConfig } from '../../core/idempotency/idempotency.config.js';
import { ConfigModule } from '@nestjs/config';
import { ReadOnlyPerCall } from '../mode/mode.guard.js';
import { SearchModule } from '../search/search.module.js';
import { McpBearerGuard } from './mcp-bearer.guard.js';
import { McpToolChecks } from './mcp-tools.js';
import { recordTools } from './mcp.record-tools.js';
import { McpAppTools } from './mcp.tools.js';

/**
 * The MCP server (README.md): @nestjs/mcp's Streamable HTTP endpoint at
 * POST /v1/mcp, a route like every other (the rate limit, the principal,
 * its tenant, the mode and break-glass guards, usage metering), for an API
 * key or a user token as a bearer (McpBearerGuard). Its tools are the
 * `@Tool()` methods of every module's providers, found at startup; each
 * call runs through the global guards again, so `@Can()` decides it.
 */
@Module({
  imports: [
    McpServerModule.forRoot({
      name: 'api',
      version: '1',
      instructions:
        'You act as the principal whose key or token you sent, with exactly its permissions. Call whoami first. Each kind of record has <path>_list, _get, _create, _update and _delete tools; describe_list tells how a list may be filtered and sorted. A refused call answers the API problem as JSON: status, code, message.',
      // Every route declares its check: any signed-in principal may open
      // the endpoint, each tool declares its own. In read-only mode the
      // mode's guard decides each call by its tool's readOnlyHint.
      decorators: [UseGuards(McpBearerGuard), Can.Anyone(), ReadOnlyPerCall()],
    }),
    DiscoveryModule,
    AccessModule,
    ListsModule,
    SearchModule,
  ],
  providers: [McpBearerGuard, McpAppTools, McpToolChecks],
})
export class McpModule {
  /**
   * A record's tools (`<path>_list`, `_get`, `_create`, `_update`,
   * `_delete`), an add-on in the feature module's imports:
   *
   * ```ts
   * imports: [McpModule.forRecord(INVOICE)]
   * ```
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: McpRecordModule,
      imports: [
        RecordsModule,
        AccessModule,
        DiscoveryModule,
        ConfigModule.forFeature(idempotencyConfig),
      ],
      providers: [{ provide: RECORD, useValue: record }, recordTools(record)],
    };
  }
}

/** The host of one forRecord(): McpModule itself would serve the endpoint again. */
@Module({})
class McpRecordModule {}

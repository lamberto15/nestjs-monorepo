import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Injectable,
  Logger,
  type OnModuleInit,
  SetMetadata,
  UseFilters,
  applyDecorators,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  ProblemDetailsFilter,
  problemCode,
} from '../../core/http/problem-details.filter.js';
import { reportError } from '../../core/observability/report-error.js';
import { MCP_TOOL_METADATA } from '../mode/mode.guard.js';

/** Where @McpTools() marks a class. */
const MCP_TOOLS = Symbol('mcp-tools');

/**
 * Metadata keys of the packages, read by McpToolChecks: `@Tool()`'s
 * (@nestjs/mcp, MCP_TOOL_METADATA, which modules/mode reads too) and
 * `@Can()`'s (@nestjs/authorization). Neither package exports them:
 * mcp-tools.spec.ts checks them against what the installed decorators
 * write, so an upgrade that renames one fails there.
 */
export const CAN = 'authorization:can';
export const CAN_ANYONE = 'authorization:can-anyone';

/** The abilities that write: a tool declaring `readOnlyHint` may not require one. */
const WRITES = new Set(['create', 'update', 'delete', 'restore']);

/** What `@Tool()` keeps of a tool, as far as the checks read it. */
interface ToolMetadata {
  options?: { annotations?: { readOnlyHint?: boolean } };
}

/**
 * What a tool's failure tells the model: the API's problem (`status`,
 * `code`, `message`, `errors` of a validation), as JSON text and as
 * `structuredContent`, with `isError`. @nestjs/mcp alone sends the
 * message only; the code is what an agent branches on, as an HTTP client
 * does. Never the internals of an unexpected error.
 */
@Catch()
export class McpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Mcp');

  catch(exception: unknown, host: ArgumentsHost): CallToolResult {
    if (host.getType<string>() !== 'mcp') {
      throw exception;
    }
    const http = ProblemDetailsFilter.toHttp(exception);
    let problem: Record<string, unknown>;
    if (http) {
      const status = http.getStatus();
      const body = http.getResponse();
      const fields = (
        typeof body === 'object' && body !== null ? body : {}
      ) as Record<string, unknown>;
      problem = {
        status,
        code:
          typeof fields.code === 'string'
            ? fields.code
            : typeof fields.errorCode === 'string'
              ? fields.errorCode
              : problemCode(status),
        message:
          typeof body === 'string'
            ? body
            : typeof fields.message === 'string'
              ? fields.message
              : http.message,
        ...(Array.isArray(fields.errors) && { errors: fields.errors }),
        ...(Array.isArray(fields.fields) && { fields: fields.fields }),
      };
    } else {
      this.logger.error(
        `A tool failed: ${(exception as Error)?.message ?? exception}`,
        (exception as Error)?.stack,
      );
      reportError(exception);
      problem = {
        status: 500,
        code: problemCode(500),
        message: t('mcp.internalError'),
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(problem) }],
      structuredContent: problem,
      isError: true,
    };
  }
}

/**
 * On a class of MCP tools (`@Tool()` methods of @nestjs/mcp): errors as
 * the API's problems (McpErrorFilter). McpToolChecks refuses a tool whose
 * class lacks it.
 */
export const McpTools = () =>
  applyDecorators(SetMetadata(MCP_TOOLS, true), UseFilters(McpErrorFilter));

/**
 * Refuses the boot when a tool, wherever it is declared, has no permission
 * check (`@Can(Policy, 'ability')` or `@Can.Anyone()`, on the method or
 * its class), its class no `@McpTools()`, or it declares `readOnlyHint`
 * (read-only mode lets it run, modules/mode) while its `@Can()` asks for a
 * write (create, update, delete, restore). @nestjs/authorization's guard
 * runs on every call and denies one without a check; refusing at the start
 * names the mistake before a client meets it.
 */
@Injectable()
export class McpToolChecks implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit() {
    const problems: string[] = [];
    const seen = new Set<object>();
    for (const { instance } of this.discovery.getProviders()) {
      if (!instance || typeof instance !== 'object' || seen.has(instance)) {
        continue;
      }
      seen.add(instance);
      const prototype = Object.getPrototypeOf(instance) as Record<
        string,
        unknown
      > | null;
      // A value made by Object.create(null) has no class, so no tool.
      if (!prototype) continue;
      const type = prototype.constructor as { name: string };
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[name] as object;
        const tool = Reflect.getMetadata(MCP_TOOL_METADATA, method) as
          ToolMetadata | undefined;
        if (!tool) continue;
        const where = `${type.name}.${name}`;
        if (!Reflect.getMetadata(MCP_TOOLS, type)) {
          problems.push(`${where}: its class has no @McpTools()`);
        }
        const checked = [CAN, CAN_ANYONE].some(
          (key) =>
            Reflect.getMetadata(key, method) !== undefined ||
            Reflect.getMetadata(key, type) !== undefined,
        );
        if (!checked) {
          problems.push(`${where}: declares no @Can() or @Can.Anyone()`);
        }
        const writes = [method, type]
          .flatMap(
            (host) =>
              (Reflect.getMetadata(CAN, host) as
                { ability: string }[] | undefined) ?? [],
          )
          .filter(({ ability }) => WRITES.has(ability));
        if (tool.options?.annotations?.readOnlyHint && writes.length > 0) {
          problems.push(
            `${where}: declares readOnlyHint, and its @Can() asks for ${writes.map((w) => w.ability).join(', ')}`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(`MCP tools refused:\n${problems.join('\n')}`);
    }
  }
}

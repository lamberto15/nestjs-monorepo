import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { ALLOW_IN_MAINTENANCE } from '../../core/http/maintenance.js';
import { ModeService } from './mode.service.js';

/** The methods that only read. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Seconds a refused client is told to wait (Retry-After). */
export const MODE_RETRY_AFTER_SECONDS = 30;

const READ_ONLY_PER_CALL = Symbol('read-only mode decides each call');

/**
 * On a route that carries calls of their own (the MCP endpoint, whose every
 * message is a POST): in read-only mode the request passes, and each call
 * is decided when it runs, by what its handler declares (an MCP tool's
 * `annotations.readOnlyHint`). Maintenance still refuses the request.
 */
export const ReadOnlyPerCall = () => SetMetadata(READ_ONLY_PER_CALL, true);

/**
 * Where @nestjs/mcp records a tool's options (`@Tool()`), on the method.
 * The package exports no constant; modules/mcp's spec checks this one
 * against what the installed package writes.
 */
export const MCP_TOOL_METADATA = 'nestjs:mcp:primitive';

/** What `@Tool()` keeps of a tool, as far as read-only mode reads it. */
interface ToolOptions {
  options?: { annotations?: { readOnlyHint?: boolean } };
}

/**
 * While `read-only`, every request that writes (not GET, HEAD or OPTIONS)
 * answers 503 `read_only`; while `maintenance`, every request does, 503
 * `maintenance`, both with Retry-After. A route marked
 * `@AllowInMaintenance()` is never refused (health, sign-in, the operators'
 * routes). An MCP tool call (`'mcp'`, through a `@ReadOnlyPerCall()`
 * route) passes in read-only mode when the tool declares
 * `readOnlyHint: true`, and is refused otherwise, as a write route is.
 * A global guard, not a route guard: it runs on every route and
 * needs no principal, so it is cheap (ModeService keeps the mode for a
 * second). WebSocket messages are not covered: realtime only pushes what an
 * HTTP write already did.
 */
@Injectable()
export class ModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mode: ModeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = context.getType<string>();
    if (type === 'mcp') {
      const mode = await this.mode.get();
      if (
        mode === 'normal' ||
        (mode === 'read-only' && this.declaresReadOnly(context))
      ) {
        return true;
      }
      throw refusal(mode);
    }
    if (type !== 'http') {
      return true;
    }
    const mode = await this.mode.get();
    if (mode === 'normal') {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ method: string }>();
    const targets = [context.getHandler(), context.getClass()];
    if (
      mode === 'read-only' &&
      (READS.has(request.method) ||
        this.reflector.getAllAndOverride<boolean | undefined>(
          READ_ONLY_PER_CALL,
          targets,
        ))
    ) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_IN_MAINTENANCE,
      targets,
    );
    if (allowed) {
      return true;
    }
    throw refusal(mode);
  }

  /** Whether an MCP tool declares that it changes nothing. */
  private declaresReadOnly(context: ExecutionContext) {
    return (
      this.reflector.get<ToolOptions | undefined>(
        MCP_TOOL_METADATA,
        context.getHandler(),
      )?.options?.annotations?.readOnlyHint === true
    );
  }
}

/** The mode's problem: 503 `read_only` or `maintenance`, with Retry-After. */
function refusal(mode: 'read-only' | 'maintenance') {
  const code = mode === 'read-only' ? 'read_only' : 'maintenance';
  return new HttpException(
    {
      code,
      message: t(mode === 'read-only' ? 'mode.readOnly' : 'mode.maintenance'),
      retryAfter: MODE_RETRY_AFTER_SECONDS,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

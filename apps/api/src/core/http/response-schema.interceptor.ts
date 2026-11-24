import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  RequestMethod,
  StandardSchemaSerializerInterceptor,
  StreamableFile,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
} from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { mergeMap, type Observable } from 'rxjs';

/** Where `@ApiOkResponse({ standardSchema })` and its siblings keep their entries (@nestjs/swagger). */
const API_RESPONSE = 'swagger/apiResponse';

type ResponseEntries = Record<string, { standardSchema?: StandardSchemaV1 }>;

/**
 * Every response is the schema its route documents, and nothing more: the
 * schema of `@ApiOkResponse({ standardSchema })` (or `@ApiCreatedResponse`,
 * the one for the route's status) is also what the response is run through,
 * so a column the schema does not declare (a `tenantId`, a hash) never
 * leaves the API, and the published document can't drift from what is
 * sent. The schema is written once, for both (root AGENTS.md, rule 5).
 *
 * Nest's `StandardSchemaSerializerInterceptor` (its `@SerializeOptions({
 * schema })` still wins), with two differences: the schema comes from the
 * route's OpenAPI entry, and the whole body is validated as it goes on the
 * wire (dates as ISO strings; an array against its array schema), because
 * the documented schemas describe the JSON, not the objects services
 * return. A response off its schema is a bug: it answers 500 and logs the
 * first issues.
 */
@Injectable()
export class ResponseSchemaInterceptor extends StandardSchemaSerializerInterceptor {
  private readonly logger = new Logger(ResponseSchemaInterceptor.name);
  private readonly documentedRoutes = new WeakMap<
    object,
    { entries: ResponseEntries; schema?: StandardSchemaV1 } | null
  >();

  constructor(private readonly routes: Reflector) {
    super(routes);
  }

  override intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const { query } = http.getRequest<{ query?: Record<string, unknown> }>();
    // shortcut: a response narrowed by ?fields= or widened by ?include= is
    // not checked: the list query and the record presenter build it from
    // declared names only, and a static schema can't describe either. Check
    // them too once record schemas describe their includes.
    if (query?.fields !== undefined || query?.include !== undefined) {
      return next.handle();
    }
    const declared = this.getContextOptions(context)?.schema;
    const documented = declared
      ? undefined
      : this.documented(context.getHandler());
    if (!declared && !documented) return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    return next.handle().pipe(
      mergeMap((body: unknown) => {
        // A handler that set its own status (`@Res({ passthrough: true })`,
        // 202 for work queued) answers that status's schema.
        const { statusCode } = http.getResponse<{ statusCode?: number }>();
        const schema =
          declared ??
          (statusCode && statusCode !== 200
            ? documented!.entries[String(statusCode)]?.standardSchema
            : undefined) ??
          documented!.schema;
        return schema ? this.check(body, schema, route) : Promise.resolve(body);
      }),
    );
  }

  /**
   * A route's documented responses, and the schema of the status it answers
   * with: its `@HttpCode()`, else 201 for POST and 200 for the rest.
   */
  private documented(handler: object) {
    let found = this.documentedRoutes.get(handler);
    if (found !== undefined) return found ?? undefined;
    const target = handler as () => unknown;
    const entries = this.routes.get<ResponseEntries | undefined>(
      API_RESPONSE,
      target,
    );
    const method = this.routes.get<RequestMethod | undefined>(
      METHOD_METADATA,
      target,
    );
    const status =
      this.routes.get<number | undefined>(HTTP_CODE_METADATA, target) ??
      (method === RequestMethod.POST ? 201 : 200);
    found = entries
      ? { entries, schema: entries[String(status)]?.standardSchema }
      : null;
    this.documentedRoutes.set(handler, found);
    return found ?? undefined;
  }

  private async check(body: unknown, schema: StandardSchemaV1, route: string) {
    // What Nest would not send as JSON (nothing, a file, a stream) passes.
    if (!isJsonBody(body)) return body;
    const wire: unknown = JSON.parse(JSON.stringify(body));
    const result = await schema['~standard'].validate(wire);
    if (!result.issues) return result.value;
    const issues = result.issues
      .slice(0, 5)
      .map(({ path, message }) => `${pathOf(path)}: ${message}`)
      .join('; ');
    this.logger.error(
      `The response of ${route} is off its documented schema: ${issues}`,
    );
    throw new Error(
      `Response of ${route} off its documented schema: ${issues}`,
    );
  }
}

/** A body Nest sends as JSON: a plain object or an array; not a file, a buffer or a stream. */
function isJsonBody(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof StreamableFile) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function pathOf(path: StandardSchemaV1.Issue['path']) {
  const keys = (path ?? []).map((segment) =>
    String(typeof segment === 'object' ? segment.key : segment),
  );
  return keys.join('.') || '(root)';
}

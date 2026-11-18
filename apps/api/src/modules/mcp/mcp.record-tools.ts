import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  type Type,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import { t } from '@nestjs/i18n';
import { IdempotencyStorage } from '@nestjs/idempotency';
import { Tool } from '@nestjs/mcp';
import { z } from 'zod';
import { assertUnchanged, etagOf } from '../../core/http/etag.js';
import type { List } from '../../core/http/list-query.js';
import { idempotencyConfig } from '../../core/idempotency/idempotency.config.js';
import { callerScope } from '../../core/idempotency/idempotency.scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { recordList } from '../records/record.list.js';
import { recordTableOf } from '../records/record-relations.js';
import { assertWritableFields } from '../records/record.routes.js';
import type { RecordSchemas } from '../records/record.schemas.js';
import { type RecordDeclaration, recordValues } from '../records/record.js';
import { RecordFeature, Records } from '../records/records.service.js';
import { McpTools } from './mcp-tools.js';

/** A query parameter as a model sends it: a value of the query string. */
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The list tool's arguments: the record's list query, one property per
 * query parameter of GET /v1/<path> (each filter key, `q`, `sort`,
 * `limit`, `cursor`…), described as the route documents them. Loose, as
 * the add-ons' filters and a tenant's custom fields join the list at
 * runtime: the record's own list (RecordPresenter.query) validates the
 * whole query, as it does for the route.
 */
function listInput(list: List) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(list.shape)) {
    if (key === 'lang') continue;
    const value =
      key === 'filter'
        ? z.union([z.string(), z.record(z.string(), z.unknown())])
        : scalar;
    shape[key] = value
      .optional()
      .describe(schema.description ?? `?${key}= of the list route.`);
  }
  return z.looseObject(shape);
}

/** The arguments as the query string the list route parses. */
const queryOf = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input as Record<string, z.infer<typeof scalar> | object>)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      ]),
  );

/** As core/idempotency's module: how long a key is remembered, and a crashed call blocks it. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;

/** An Idempotency-Key, as the HTTP header takes it. */
const keySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x20-\x7e]+$/)
  .describe(
    'As the Idempotency-Key header of POST: a retry with the same key and arguments answers the record the first call created instead of creating another. A new random key per record.',
  );

/** An If-Match, as the HTTP header takes it. */
const ifMatch = z
  .string()
  .max(1000)
  .optional()
  .describe(
    'As the If-Match header: the etag the get (or the last change) answered. The call is refused (412 precondition_failed) when the record changed since; without it the change goes ahead.',
  );

/**
 * Whether `_create` takes a key, as POST /v1/<path> does
 * (RecordIdempotent): the record's `idempotency`, else the deployment's
 * IDEMPOTENCY.
 */
export function createKeyRule(
  record: RecordDeclaration,
  deployment: 'required' | 'optional',
): 'required' | 'optional' | 'off' {
  return record.idempotency ?? deployment;
}

/** `_create`'s and `_update`'s arguments, from the feature's schemas (with its add-ons' keys). */
export function writeInputs(
  schemas: RecordSchemas,
  rule: 'required' | 'optional' | 'off',
  id: z.ZodType,
) {
  return {
    create:
      rule === 'off'
        ? schemas.create
        : schemas.create.extend({
            idempotencyKey:
              rule === 'required' ? keySchema : keySchema.optional(),
          }),
    update: z.object({
      id,
      changes: schemas.update.describe('Only the fields to change.'),
      ifMatch,
    }),
  };
}

/** The same JSON for the same arguments, whatever their keys' order. */
function fingerprintOf(value: unknown) {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [
                key,
                canonical((v as Record<string, unknown>)[key]),
              ]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('base64url');
}

/**
 * A record's tools: `<path>_list`, `_get`, `_create`, `_update`,
 * `_delete`, each the HTTP route's path through the record's store and
 * presenter (the add-ons' hooks, quotas, audit, events; what the caller
 * may see), with its checks: the policy on the row, field-level
 * permissions, a record the caller may not read is the 404 of a missing
 * one. No looser than the routes: `_get`, `_create` and `_update`
 * answer `{ etag, record }`, and `_update`/`_delete` take it as
 * `ifMatch` (If-Match: optional, as on HTTP); `_create` takes an
 * `idempotencyKey` when POST takes an Idempotency-Key, required when it
 * does. The write arguments are the feature's schemas (RecordFeature),
 * add-on keys included: found when the tools are made, before the server
 * reads them.
 */
export function recordTools(record: RecordDeclaration): Type {
  const list = recordList(record, recordTableOf(record));
  const id = z.uuid().describe(`The ${record.noun}'s id.`);
  const idInput = z.object({ id });
  const deleteInput = z.object({ id, ifMatch });
  let inputs: ReturnType<typeof writeInputs> | undefined;
  const made = () => {
    if (!inputs) {
      throw new Error(`${record.subject}'s MCP tools are not made yet.`);
    }
    return inputs;
  };
  const route = `/v1/${record.path}`;
  const createName = `${record.path}_create`;

  @McpTools()
  @Injectable()
  class RecordTools {
    constructor(
      private readonly records: Records,
      private readonly access: AccessService,
      private readonly authorization: AuthorizationService,
      private readonly storage: IdempotencyStorage,
      discovery: DiscoveryService,
      @Inject(idempotencyConfig.KEY)
      config: ConfigType<typeof idempotencyConfig>,
    ) {
      // RecordsModule.forFeature()'s value: there before any provider is made.
      const feature = discovery
        .getProviders()
        .map((wrapper) => wrapper.instance as unknown)
        .find(
          (found): found is RecordFeature =>
            found instanceof RecordFeature &&
            found.declaration.subject === record.subject,
        );
      if (!feature) {
        throw new Error(
          `McpModule.forRecord(${record.subject.toUpperCase()}): no module registers ${record.subject}: import RecordsModule.forFeature() in its feature module.`,
        );
      }
      inputs = writeInputs(
        feature.schemas,
        createKeyRule(feature.declaration, config.mode),
        id,
      );
    }

    private get registration() {
      return this.records.of(record.subject);
    }

    /** A record as its routes answer it, with the ETag they send. */
    private async shown(user: RequestPrincipal, row: Record<string, unknown>) {
      const shown = await this.registration.presenter.one(user, row);
      return { etag: etagOf(shown), record: shown };
    }

    @Tool({
      name: `${record.path}_list`,
      title: `List ${record.noun} records`,
      description: `The ${record.noun} records you may read, newest first, a page at a time ({ items, nextCursor }): every argument is a query parameter of GET ${route}, filters, sort, search (q), fields, deleted. describe_list tells the filters and their operators.`,
      inputSchema: listInput(list),
      annotations: { readOnlyHint: true },
    })
    @Can.Anyone() // Only those the caller may read: filtered in the query.
    async list(
      input: Record<string, unknown>,
      _context: unknown,
      @CurrentUser() user: RequestPrincipal,
    ) {
      const { store, presenter } = this.registration;
      const { list, query } = await presenter.query(user, queryOf(input));
      const page = await store.findPage(user, list, query);
      return presenter.page(user, page, { list, query });
    }

    @Tool({
      name: `${record.path}_get`,
      title: `Get a ${record.noun}`,
      description: `One ${record.noun} by its id, as GET ${route}/{id} answers it: { etag, record }. Pass the etag as ifMatch to change or delete it.`,
      inputSchema: idInput,
      annotations: { readOnlyHint: true },
    })
    @Can.Anyone() // Checked below, on the record itself.
    async get(
      input: z.infer<typeof idInput>,
      _context: unknown,
      @CurrentUser() user: RequestPrincipal,
    ) {
      const { store, feature } = this.registration;
      const row = await store.findOne(input.id, { visibleTo: user });
      await this.authorization.authorize(feature.policy, 'read', user, row);
      return this.shown(user, row);
    }

    @Tool({
      name: createName,
      title: `Create a ${record.noun}`,
      description: `Creates a ${record.noun}, as POST ${route}: answers { etag, record } as created.`,
      inputSchema: z.lazy(() => made().create),
      annotations: { readOnlyHint: false, destructiveHint: false },
    })
    @Can.Anyone() // Checked below, with the record's policy (create).
    async create(
      { idempotencyKey, ...input }: Record<string, unknown>,
      _context: unknown,
      @CurrentUser() user: RequestPrincipal,
    ) {
      if (typeof idempotencyKey !== 'string') {
        return this.shown(user, await this.created(user, input));
      }
      // As the HTTP interceptor (core/idempotency): one run per caller and
      // key; a retry answers that record (as it is now), other arguments
      // under the same key are refused. A failed run frees the key.
      const store = this.storage.source;
      const key = `${callerScope({ user })}:mcp:${createName}:${idempotencyKey}`;
      const fingerprint = fingerprintOf(input);
      const owner = randomUUID();
      const found = await store.acquire(key, owner, fingerprint, LOCK_TTL_MS);
      if (found.state !== 'acquired') {
        if (found.fingerprint !== fingerprint) {
          throw new UnprocessableEntityException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: t('mcp.keyReused'),
          });
        }
        if (found.state === 'in-flight') {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_IN_USE',
            message: t('mcp.keyInUse'),
          });
        }
        const { id } = (found.response as { body: { id: string } }).body;
        const row = await this.registration.store.findOne(id, {
          visibleTo: user,
        });
        return this.shown(user, row);
      }
      let row: Record<string, unknown>;
      try {
        row = await this.created(user, input);
      } catch (error) {
        await store.release(key, owner);
        throw error;
      }
      await store.complete(
        key,
        owner,
        { status: 201, headers: {}, body: { id: row.id } },
        KEY_TTL_MS,
      );
      return this.shown(user, row);
    }

    private async created(
      user: RequestPrincipal,
      input: Record<string, unknown>,
    ) {
      const { store, feature } = this.registration;
      await this.authorization.authorize(feature.policy, 'create', user);
      await assertWritableFields(this.access, user, 'create', record, input);
      return (await store.create(user, recordValues(record, input), {
        input,
      })) as Record<string, unknown>;
    }

    @Tool({
      name: `${record.path}_update`,
      title: `Change a ${record.noun}`,
      description: `Changes a ${record.noun}, as PATCH ${route}/{id}: only the fields in changes. Answers { etag, record } as changed.`,
      inputSchema: z.lazy(() => made().update),
      annotations: { readOnlyHint: false, idempotentHint: true },
    })
    @Can.Anyone() // Checked below, on the record and on each field.
    async update(
      {
        id,
        changes,
        ifMatch,
      }: { id: string; changes: Record<string, unknown>; ifMatch?: string },
      _context: unknown,
      @CurrentUser() user: RequestPrincipal,
    ) {
      const { store, presenter, feature } = this.registration;
      await store.findOne(id, { visibleTo: user });
      const row = await store.update(user, id, recordValues(record, changes), {
        check: async (current) => {
          await this.authorization.authorize(
            feature.policy,
            'update',
            user,
            current,
          );
          await assertWritableFields(
            this.access,
            user,
            'update',
            record,
            changes,
            current,
          );
          assertUnchanged(ifMatch, await presenter.one(user, current));
        },
        input: changes,
      });
      return this.shown(user, row);
    }

    @Tool({
      name: `${record.path}_delete`,
      title: `Delete a ${record.noun}`,
      description: record.softDelete
        ? `Deletes a ${record.noun}, as DELETE ${route}/{id}: to the recycle bin, where it can be restored.`
        : `Deletes a ${record.noun} for good, as DELETE ${route}/{id}.`,
      inputSchema: deleteInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    })
    @Can.Anyone() // Checked below, on the record itself.
    async delete(
      input: z.infer<typeof deleteInput>,
      _context: unknown,
      @CurrentUser() user: RequestPrincipal,
    ) {
      const { store, presenter, feature } = this.registration;
      await store.findOne(input.id, { visibleTo: user });
      await store.delete(user, input.id, {
        check: async (current) => {
          await this.authorization.authorize(
            feature.policy,
            'delete',
            user,
            current,
          );
          assertUnchanged(input.ifMatch, await presenter.one(user, current));
        },
      });
      return { id: input.id, deleted: true };
    }
  }
  Object.defineProperty(RecordTools, 'name', {
    value: `${record.subject}McpTools`,
  });
  return RecordTools;
}

import {
  Injectable,
  NotFoundException,
  type OnModuleInit,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AuthorizationService } from '@nestjs/authorization';
import { fieldsRead, type List } from '../../core/http/list-query.js';
import { AccessPolicy } from '../../iam/access/access.policy.js';
import { USER_LIST } from '../../iam/access/access.lists.js';
import { AUDIT_LIST, SIGN_IN_LIST } from '../../iam/audit-log/audit.lists.js';
import { AuditPolicy } from '../../iam/audit-log/audit.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  declarationOfTable,
  type RecordRelation,
  relationsFrom,
  relationsTo,
  relationTitle,
} from '../records/record-relations.js';
import { RecordTitles } from '../records/record-titles.js';
import {
  type RecordRegistration,
  Records,
} from '../records/records.service.js';
import { checkListViews, listMetadata, listViews } from './list-metadata.js';
import { ListPolicy } from './list.policy.js';
import { ListsRepository } from './lists.repository.js';
import type { RecordOptionsQuery } from './record-options.schemas.js';
import type {
  ListField,
  ListMetadata,
  ListViewsDeclaration,
} from './list-metadata.schemas.js';

/** A subject's list as GET /v1/lists/{subject} describes it. */
interface ListSource {
  readonly subject: string;
  readonly list: List;
  readonly views?: ListViewsDeclaration;
  /** Its record, for a record's list: its add-ons' capabilities and keys. */
  readonly record?: RecordRegistration;
  /** Who may read the description, when not whoever may `read` the subject. */
  readonly readable?: (principal: Principal | null) => Promise<boolean>;
}

/**
 * Lists described for clients (GET /v1/lists/{subject}): each record's
 * (modules/records: its list with its add-ons' filters), and the access
 * API's users (GET /v1/access/users), less what the caller's field-level
 * permissions hide. A record's add-ons say what they add: their
 * `capability` (and whether it works here, `available()`) and keys of
 * their own (`describe()`).
 */
@Injectable()
export class ListsService implements OnModuleInit {
  constructor(
    private readonly records: Records,
    private readonly titles: RecordTitles,
    private readonly access: AccessService,
    private readonly accessPolicy: AccessPolicy,
    private readonly auditPolicy: AuditPolicy,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly repository: ListsRepository,
  ) {}

  /** GET /v1/lists/{subject}: an unknown subject is a 404 before any permission is asked. */
  async describeFor(principal: Principal, subject: string) {
    this.source(subject);
    await this.authorization.authorize(ListPolicy, 'read', principal, subject);
    return this.describe(principal, subject);
  }

  /** GET /v1/lists/{subject}/options: a 404 for a subject that is no record, before any permission. */
  async optionsFor(
    principal: Principal,
    subject: string,
    query: RecordOptionsQuery,
  ) {
    if (!this.source(subject).record) {
      throw new NotFoundException(`${subject} is no record.`);
    }
    await this.authorization.authorize(ListPolicy, 'read', principal, subject);
    return { items: await this.options(principal, subject, query) };
  }

  /**
   * A record's options for a picker (GET /v1/lists/{subject}/options): its
   * id and title (RecordTitles: its title field after its parent's, the
   * same as a reference's `?include=`),
   * among the live records the caller may read. `q` searches the title,
   * `id` names these; a title they may not read on every record is null.
   * Any other parameter is a filter of the record's own list, checked as
   * that list checks it (`?productId=<id>`: a product's statuses only).
   */
  async options(
    principal: Principal,
    subject: string,
    { q, id, limit, lang: _lang, ...filters }: RecordOptionsQuery,
  ) {
    const record = this.records.find(subject);
    if (!record) throw new NotFoundException(`${subject} is no record.`);
    let filtered: ReturnType<List['where']> | undefined;
    if (Object.keys(filters).length) {
      const list = await record.listFor(principal);
      const query = list.parse(filters);
      await this.access.assertQueryFields(principal, subject, query);
      filtered = list.where(query);
    }
    const title = await this.titles.titleField(principal, subject);
    // Without a readable title a search has nothing to match.
    if (q && !title) return [];
    const ids = await this.repository.optionIds(record, {
      id,
      q,
      title,
      filters: [
        filtered,
        await this.access.sqlFilter(principal, subject, 'read'),
      ],
      limit,
    });
    // Each named after its parent's title, when it has a parent (RecordTitles).
    const titles = await this.titles.of(principal, subject, ids);
    return ids.map((id) => ({ id, title: titles.get(id) ?? null }));
  }

  /** The paths with a list route (`GET /v1/<path>`): what a related panel can call. */
  private listed = new Set<string>();

  /** A record's views must name fields of its list: a mistake fails at startup. */
  onModuleInit() {
    for (const record of this.records.all()) {
      const { subject, views } = record.declaration;
      if (views) checkListViews(subject, record.list, views);
    }
    this.listed = this.listRoutes();
    for (const relation of this.throughRelations()) {
      const route = throughRoute(relation);
      const listed = [...this.listed].some(
        (path) => path.replace(/:[^/]+/g, ':id') === route,
      );
      if (!listed) {
        throw new Error(
          `${relation.from.subject} is read through ${relation.field} (readThrough): no GET /v1/${throughPath(relation)} route lists them.`,
        );
      }
    }
  }

  /** The relations children are read through (`readThrough` of their declaration). */
  private throughRelations() {
    return this.records
      .all()
      .flatMap(({ declaration }) =>
        relationsFrom(declaration).filter(
          (relation) => relation.field === declaration.readThrough,
        ),
      );
  }

  /**
   * The controllers' paths that answer `GET /<path>` itself: a record
   * reached only through another's routes (`/v1/accounts/:id/notes`) has
   * none, so no panel lists it.
   */
  private listRoutes() {
    const found = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = this.reflector.get<string | string[] | undefined>(
        PATH_METADATA,
        metatype,
      );
      const prototype = Object.getPrototypeOf(instance) as object;
      const listsItself = this.scanner
        .getAllMethodNames(prototype)
        .some((name) => {
          const handler = (prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') return false;
          const method = this.reflector.get<RequestMethod | undefined>(
            METHOD_METADATA,
            handler,
          );
          const path = this.reflector.get<string | string[] | undefined>(
            PATH_METADATA,
            handler,
          );
          return (
            method === RequestMethod.GET &&
            [path ?? '/'].flat().some((p) => trim(p) === '')
          );
        });
      if (listsItself) {
        for (const p of [base ?? '/'].flat()) found.add(trim(p));
      }
    }
    return found;
  }

  /** The subject's list, or a 404: before any permission is checked. */
  source(subject: string): ListSource {
    const record = this.records.find(subject);
    if (record) {
      return {
        subject,
        list: record.list,
        views: record.declaration.views,
        record,
      };
    }
    // The access API's users: not a record, so no capabilities, no recycle bin.
    if (subject === 'User') {
      return {
        subject,
        list: USER_LIST,
        readable: (principal) => this.accessPolicy.open(principal),
      };
    }
    // The audit pages' lists (iam/audit-log): whoever holds Access.readAudit,
    // the condition AuditPolicy asks.
    if (subject === 'Audit' || subject === 'SignIn') {
      return {
        subject,
        list: subject === 'Audit' ? AUDIT_LIST : SIGN_IN_LIST,
        readable: (principal) => this.auditPolicy.readAudit(principal),
      };
    }
    throw new NotFoundException(`${subject} has no list.`);
  }

  /** Whether the principal may read the subject's list description (ListPolicy). */
  mayRead(principal: Principal | null, subject: string): Promise<boolean> {
    const { readable } = this.source(subject);
    return readable
      ? readable(principal)
      : this.access.can(principal, 'read', subject);
  }

  /**
   * The list as `principal` may use it: a field they may read on no
   * record is left out; one they may read on some records only is neither
   * filterable nor sortable (nor `q` when it reads one), only selectable.
   */
  async describe(principal: Principal, subject: string): Promise<ListMetadata> {
    const source = this.source(subject);
    // A record's: with what its extensions' listFields() give for this caller.
    const list = source.record
      ? await source.record.listFor(principal)
      : source.list;
    const [denied, conditional, restore] = await Promise.all([
      this.access.deniedFields(principal, 'read', subject),
      this.access.conditionalFields(principal, 'read', subject),
      list.options.softDelete
        ? this.access.can(principal, 'restore', subject)
        : false,
    ]);
    const hiddenFields = new Set(denied);
    const conditionalFields = new Set(conditional);
    // The list routes refuse the same names (AccessService.assertQueryFields).
    const hidden = (name: string) =>
      fieldsRead(list.fields, name).some((field) => hiddenFields.has(field));
    const unmatchable = (name: string) =>
      fieldsRead(list.fields, name).some((field) =>
        conditionalFields.has(field),
      );
    const metadata = listMetadata(subject, list, {
      hidden,
      unmatchable,
      recycleBin: restore,
    });
    const extensions = source.record?.extensions ?? [];
    const capabilities = Object.fromEntries(
      extensions.flatMap((hooks) =>
        hooks.capability
          ? [[hooks.capability, hooks.available?.() ?? true] as const]
          : [],
      ),
    );
    const contributed = await Promise.all(
      extensions.map((hooks) =>
        hooks.describe ? hooks.describe(principal) : Promise.resolve({}),
      ),
    );
    return {
      ...Object.assign({}, ...contributed),
      ...metadata,
      capabilities,
      related: await this.related(principal, subject),
      views: listViews(source.views, metadata.fields as ListField[]),
    };
  }

  /**
   * The relations that refer to the subject's records (modules/records,
   * record-relations.ts), as the caller may follow them: the referring
   * record is registered, they may read it, and may filter by the field
   * (one they may read on every record).
   */
  private async related(
    principal: Principal,
    subject: string,
  ): Promise<ListMetadata['related']> {
    const related: ListMetadata['related'] = [];
    for (const relation of relationsTo(subject)) {
      const from = relation.from.subject;
      const child = this.records.find(from);
      if (child && relation.from.readThrough === relation.field) {
        // Read through this record, by whoever may read it: at its route,
        // described here (the reader may not read the child's own list).
        if (!(await this.mayRead(principal, subject))) continue;
        const metadata = listMetadata(from, child.list);
        related.push({
          subject: from,
          path: throughPath(relation),
          field: relation.field,
          title: relationTitle(relation.from),
          required: relation.required,
          onDelete: relation.onDelete,
          through: {
            fields: metadata.fields as ListField[],
            select: metadata.select as string[],
          },
        });
        continue;
      }
      if (
        !this.records.find(from) ||
        // The panel lists them at `GET /v1/<path>`: none without that route.
        !this.listed.has(relation.from.path) ||
        !(await this.mayRead(principal, from))
      ) {
        continue;
      }
      const [denied, conditional] = await Promise.all([
        this.access.deniedFields(principal, 'read', from),
        this.access.conditionalFields(principal, 'read', from),
      ]);
      if (
        denied.includes(relation.field) ||
        conditional.includes(relation.field)
      ) {
        continue;
      }
      related.push({
        subject: from,
        path: relation.from.path,
        field: relation.field,
        title: relationTitle(relation.from),
        required: relation.required,
        onDelete: relation.onDelete,
      });
    }
    return related;
  }
}

/** `/invoices/` → `invoices`. */
const trim = (path: string) => path.replace(/^\/+|\/+$/g, '');

/** `accounts/{id}/notes`: the route a child read through its parent is listed at, under /v1. */
const throughPath = (relation: RecordRelation) =>
  `${declarationOfTable(relation.targetTable())?.path}/{id}/${relation.from.path}`;

/** The same path as a controller declares it, its parameter named `id` (`accounts/:id/notes`; the controller's may be `:accountId`). */
const throughRoute = (relation: RecordRelation) =>
  throughPath(relation).replace('{id}', ':id');

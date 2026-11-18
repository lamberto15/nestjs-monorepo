import {
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { fieldsRead, type List } from '../../core/http/list-query.js';
import { AccessPolicy } from '../../iam/access/access.policy.js';
import { USER_LIST } from '../../iam/access/access.lists.js';
import { AUDIT_LIST, SIGN_IN_LIST } from '../../iam/audit-log/audit.lists.js';
import { AuditPolicy } from '../../iam/audit-log/audit.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { relationsTo, relationTitle } from '../records/record-relations.js';
import {
  type RecordRegistration,
  Records,
} from '../records/records.service.js';
import { checkListViews, listMetadata, listViews } from './list-metadata.js';
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
    private readonly access: AccessService,
    private readonly accessPolicy: AccessPolicy,
    private readonly auditPolicy: AuditPolicy,
  ) {}

  /** A record's views must name fields of its list: a mistake fails at startup. */
  onModuleInit() {
    for (const record of this.records.all()) {
      const { subject, views } = record.declaration;
      if (views) checkListViews(subject, record.list, views);
    }
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
      if (!this.records.find(from) || !(await this.mayRead(principal, from))) {
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

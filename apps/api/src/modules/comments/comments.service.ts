import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { PeopleService } from '../people/people.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SubscriptionsService } from '../notifications/subscriptions.service.js';
import { InjectRecord } from '../records/record-extension.js';
import { relationTitle } from '../records/record-relations.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { COMMENT_LIST } from './comments.lists.js';
import { recordCommented } from './comments.events.js';
import type { CommentView } from './comments.schemas.js';
import { comments } from './comments.tables.js';

type Comment = typeof comments.$inferSelect;
type Action = 'added' | 'edited' | 'removed' | 'resolved' | 'reopened';

/** A thread (a top-level comment) takes this many replies; threads are one level deep. */
export const MAX_REPLIES = 200;
/** At most this many people are mentioned in one comment (the rest are ignored). */
const MAX_MENTIONS = 20;
/** Notifications quote this much of the comment. */
const EXCERPT = 140;
/** The most watchers a push to open pages looks at. */
const MAX_AUDIENCE = 200;

/**
 * `@ada@example.com` or `@user:<uuid>`, after a space, a bracket or the
 * start (so an address in the text, `ada@example.com`, mentions nobody).
 * A sentence's full stop after an address isn't part of it.
 */
const MENTION =
  /(?<![\w@.])@(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/gi;

/** What `view()` names: people by key, and the addresses (lower-cased) that resolve to one. */
interface Names {
  names: ReadonlyMap<string, string | null>;
  emails: ReadonlyMap<string, string>;
}

/**
 * The comments of one record type (`CommentsModule.forRecord(RECORD)`):
 * whoever may read a record reads and writes its comments (a 404 otherwise,
 * as for a missing record); the author edits their own; the author or whoever
 * may change the record removes one.
 *
 * Each write is one transaction with its audit entry (`comment.added`,
 * `-edited`, `-removed`, `-resolved`, `-reopened`: the comment as target,
 * the record in the details, never the text) and its notifications: the
 * people mentioned who may read the record get `comment.mentioned`; a reply
 * tells its thread's author (`comment.replied`); the record's watchers, but
 * those two and the author, get `comment.added`. The author watches the
 * record from their first comment on it. After the commit the record's open
 * pages hear of it (`record.commented`).
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger('Comments');

  constructor(
    @InjectRecord() private readonly record: RecordDeclaration,
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly people: PeopleService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly realtime: Realtime,
  ) {}

  /** A page of the record's comments, oldest first unless the query sorts. */
  async list(principal: Principal, recordId: string, query: ListQuery) {
    await this.readable(principal, recordId);
    const where = and(this.of(recordId), COMMENT_LIST.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(comments)
        .where(and(where, this.after(query)))
        .orderBy(...this.order(query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, comments, where, query),
    ]);
    const page = toPage(rows, query, total);
    const known = await this.nameMap(page.items);
    return { ...page, items: page.items.map((row) => view(row, known)) };
  }

  /** Adds a comment; notifies those mentioned, the thread's author and the record's watchers. */
  async add(
    principal: Principal,
    recordId: string,
    body: string,
    parentId?: string,
    ip?: string,
  ) {
    const record = await this.readable(principal, recordId);
    const mentions = await this.mentions(record, body, principal);
    const author = principalKey(principal);
    const row = await this.txHost.withTransaction(async () => {
      const parent = parentId ? await this.findOne(recordId, parentId) : null;
      if (parent?.parentId) {
        throw new BadRequestException({
          code: 'comment_reply_too_deep',
          message: 'Threads are one level deep: answer the top-level comment.',
        });
      }
      if (parent?.resolvedAt) {
        throw new ConflictException({
          code: 'comment_thread_resolved',
          message: 'The thread is resolved: reopen it to answer.',
        });
      }
      if (parent) {
        const [counted] = await this.db
          .select({ replies: count() })
          .from(comments)
          .where(eq(comments.parentId, parent.id));
        if ((counted?.replies ?? 0) >= MAX_REPLIES) {
          throw new ConflictException({
            code: 'comment_thread_full',
            message: `A thread takes at most ${MAX_REPLIES} replies: start a new one.`,
          });
        }
      }
      const [earlier] = await this.db
        .select({ id: comments.id })
        .from(comments)
        .where(and(this.of(recordId), eq(comments.author, author)))
        .limit(1);
      const [created] = await this.db
        .insert(comments)
        .values({
          subject: this.record.subject,
          recordId,
          author,
          body,
          mentions,
          parentId: parent?.id ?? null,
        })
        .returning();
      await this.audit.record(principal, {
        action: 'comment.added',
        targetType: 'comment',
        targetId: created!.id,
        details: {
          subject: this.record.subject,
          recordId,
          mentions,
          parentId: parent?.id ?? null,
        },
        ip,
      });
      await this.notify(record, created!, principal, mentions, parent);
      // Their first comment here: they hear of the answers.
      if (!earlier)
        await this.subscriptions.subscribe(principal, this.ref(recordId));
      return created!;
    });
    this.pushed(principal, row, 'added');
    return view(row, await this.nameMap([row]));
  }

  /** Changes the text of the principal's own comment; the people newly mentioned are told. */
  async edit(
    principal: Principal,
    recordId: string,
    id: string,
    body: string,
    ip?: string,
  ) {
    const record = await this.readable(principal, recordId);
    const comment = await this.findOne(recordId, id);
    if (comment.author !== principalKey(principal)) {
      throw new ForbiddenException('Only its author may change a comment.');
    }
    if (comment.body === body) {
      return view(comment, await this.nameMap([comment]));
    }
    const mentions = await this.mentions(record, body, principal);
    const row = await this.txHost.withTransaction(async () => {
      const [updated] = await this.db
        .update(comments)
        .set({ body, mentions, editedAt: new Date() })
        .where(eq(comments.id, id))
        .returning();
      await this.audit.record(principal, {
        action: 'comment.edited',
        targetType: 'comment',
        targetId: id,
        details: { subject: this.record.subject, recordId, mentions },
        ip,
      });
      const added = mentions.filter((key) => !comment.mentions.includes(key));
      await this.tellMentioned(record, updated!, principal, added);
      return updated!;
    });
    this.pushed(principal, row, 'edited');
    return view(row, await this.nameMap([row]));
  }

  /** Removes a comment for good: its author, or whoever may change the record. */
  async remove(
    principal: Principal,
    recordId: string,
    id: string,
    ip?: string,
  ) {
    const record = await this.readable(principal, recordId);
    const comment = await this.findOne(recordId, id);
    await this.assertAuthorOrModerator(principal, record, comment, 'remove');
    await this.txHost.withTransaction(async () => {
      // A thread's replies go with its top-level comment (the foreign key cascades).
      const [counted] = comment.parentId
        ? []
        : await this.db
            .select({ replies: count() })
            .from(comments)
            .where(eq(comments.parentId, id));
      await this.db.delete(comments).where(eq(comments.id, id));
      await this.audit.record(principal, {
        action: 'comment.removed',
        targetType: 'comment',
        targetId: id,
        details: {
          subject: this.record.subject,
          recordId,
          author: comment.author,
          parentId: comment.parentId,
          replies: counted?.replies ?? 0,
        },
        ip,
      });
    });
    this.pushed(principal, comment, 'removed');
  }

  /** Resolves a thread: its author, or whoever may change the record. Repeating it changes nothing. */
  resolve(principal: Principal, recordId: string, id: string, ip?: string) {
    return this.setResolved(principal, recordId, id, true, ip);
  }

  /** Reopens a resolved thread, as resolving it. */
  reopen(principal: Principal, recordId: string, id: string, ip?: string) {
    return this.setResolved(principal, recordId, id, false, ip);
  }

  /** Records gone for good (a purge, a delete without bin): their comments go too, in that transaction. */
  /** A merge: the duplicate's comments move to the survivor. */
  async merge(from: string, to: string) {
    await this.db
      .update(comments)
      .set({ recordId: to })
      .where(
        and(
          eq(comments.subject, this.record.subject),
          eq(comments.recordId, from),
        ),
      );
  }

  async forget(ids: readonly string[]) {
    if (ids.length === 0) return;
    await this.db
      .delete(comments)
      .where(
        and(
          eq(comments.subject, this.record.subject),
          inArray(comments.recordId, [...ids]),
        ),
      );
  }

  private async setResolved(
    principal: Principal,
    recordId: string,
    id: string,
    resolved: boolean,
    ip?: string,
  ) {
    const record = await this.readable(principal, recordId);
    const comment = await this.findOne(recordId, id);
    if (comment.parentId) {
      throw new BadRequestException({
        code: 'comment_not_thread',
        message: 'Only a top-level comment (a thread) can be resolved.',
      });
    }
    await this.assertAuthorOrModerator(principal, record, comment, 'resolve');
    if (!!comment.resolvedAt === resolved) {
      return view(comment, await this.nameMap([comment]));
    }
    const row = await this.txHost.withTransaction(async () => {
      const [updated] = await this.db
        .update(comments)
        .set(
          resolved
            ? { resolvedAt: new Date(), resolvedBy: principalKey(principal) }
            : { resolvedAt: null, resolvedBy: null },
        )
        .where(eq(comments.id, id))
        .returning();
      await this.audit.record(principal, {
        action: resolved ? 'comment.resolved' : 'comment.reopened',
        targetType: 'comment',
        targetId: id,
        details: { subject: this.record.subject, recordId },
        ip,
      });
      return updated!;
    });
    this.pushed(principal, row, resolved ? 'resolved' : 'reopened');
    return view(row, await this.nameMap([row]));
  }

  private async assertAuthorOrModerator(
    principal: Principal,
    record: RecordRow,
    comment: Comment,
    verb: string,
  ) {
    if (
      comment.author !== principalKey(principal) &&
      !(await this.access.can(principal, 'update', this.record.subject, record))
    ) {
      throw new ForbiddenException(
        `Only its author or whoever may change the ${this.record.noun} may ${verb} a comment.`,
      );
    }
  }

  /** The record, once the principal may read it: else a 404, the same whether it is missing or unreadable. */
  private readable(principal: Principal, recordId: string) {
    return this.records
      .of(this.record.subject)
      .store.findOne(recordId, { visibleTo: principal });
  }

  private async canRead(principal: Principal, recordId: string) {
    try {
      await this.readable(principal, recordId);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  private async findOne(recordId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(comments)
      .where(and(this.of(recordId), eq(comments.id, id)));
    if (!row) throw new NotFoundException(`Comment ${id} not found.`);
    return row;
  }

  private ref(recordId: string) {
    return { subject: this.record.subject, recordId };
  }

  private of(recordId: string) {
    return and(
      eq(comments.subject, this.record.subject),
      eq(comments.recordId, recordId),
    );
  }

  /** Oldest first by default (a conversation reads down); `?sort=` as any list. */
  private order(query: ListQuery) {
    return query.sort?.length
      ? pageOrder(comments.id, query)
      : [asc(comments.id)];
  }

  private after(query: ListQuery) {
    if (!query.cursor || query.sort?.length) {
      return afterCursor(comments.id, query);
    }
    return gt(comments.id, query.cursor);
  }

  /**
   * The principal keys of the active users the body mentions who are members
   * of the tenant and may read the record, but the author; anyone else is
   * silently left out (a mention never tells who exists, or that the record
   * does). Users are global: an address of someone outside the tenant is
   * nobody here.
   */
  private async mentions(record: RecordRow, body: string, author: Principal) {
    const tenantId = requireTenantId('A mention');
    const keys = new Set<string>();
    for (const handle of handlesOf(body)) {
      const account = handle.startsWith('user:')
        ? await this.users.findActive(handle.slice('user:'.length))
        : (await this.users.findActiveByEmail(handle))?.user;
      const user = account && (await this.users.inTenant(account.id, tenantId));
      if (
        user?.tenantId === tenantId &&
        principalKey(user) !== principalKey(author) &&
        (await this.canRead(user, record.id))
      ) {
        keys.add(principalKey(user));
      }
    }
    return [...keys];
  }

  /**
   * The names `view()` needs, in one query whatever the number of comments:
   * of the authors and the mentioned people (the tenant's members, active or
   * not), and the addresses written in the bodies that name a mention.
   */
  private async nameMap(rows: Comment[]): Promise<Names> {
    const keys = new Set(rows.flatMap((row) => [row.author, ...row.mentions]));
    const addresses = new Set(rows.flatMap((row) => emailHandlesOf(row.body)));
    const [names, emails] = await Promise.all([
      this.people.names(keys),
      // Only among the keys already mentioned: an address nobody resolved stays without a name.
      this.people.keysOfEmails(addresses, keys),
    ]);
    return { names, emails };
  }

  /** In the write's transaction: the mentioned, the thread's author on a reply, then the watchers. */
  private async notify(
    record: RecordRow,
    comment: Comment,
    by: Principal,
    mentioned: string[],
    parent: Comment | null,
  ) {
    await this.tellMentioned(record, comment, by, mentioned);
    const skip = new Set([principalKey(by), ...mentioned]);
    if (parent && !skip.has(parent.author)) {
      // The thread's author hears of the reply (comment.replied) if they still may read the record.
      const author = await this.activeReader(parent.author, record.id);
      if (author) {
        await this.notifications.notify({
          type: 'comment.replied',
          to: parent.author,
          data: this.data(record, comment, by),
          link: this.link(record.id),
        });
      }
    }
    if (parent) skip.add(parent.author);
    const to = (await this.subscriptions.watchers(this.ref(record.id))).filter(
      (watcher) => !skip.has(watcher),
    );
    await this.notifications.notify({
      type: 'comment.added',
      to,
      data: this.data(record, comment, by),
      // Several comments collapse into one notification per record, counted up.
      key: `comment.added:${record.id}`,
      link: this.link(record.id),
    });
  }

  private async tellMentioned(
    record: RecordRow,
    comment: Comment,
    by: Principal,
    mentioned: string[],
  ) {
    if (mentioned.length === 0) return;
    await this.notifications.notify({
      type: 'comment.mentioned',
      to: mentioned,
      data: this.data(record, comment, by),
      link: this.link(record.id),
    });
  }

  /** The user behind a key, in this tenant, when they may read the record. */
  private async activeReader(key: string, recordId: string) {
    if (!key.startsWith('user:')) return null;
    const user = await this.users.inTenant(
      key.slice('user:'.length),
      requireTenantId('A reply'),
    );
    return user && (await this.canRead(user, recordId)) ? user : null;
  }

  private data(record: RecordRow, comment: Comment, by: Principal) {
    const field = relationTitle(this.record);
    const title = field ? record[field] : null;
    return {
      subject: this.record.subject,
      recordId: record.id,
      commentId: comment.id,
      title: typeof title === 'string' ? title : this.record.noun,
      by: by.name,
      excerpt: excerpt(comment.body),
    };
  }

  /** The record in the web app: a path, for notifications. */
  private link(recordId: string) {
    return `/${this.record.path}/${recordId}`;
  }

  /**
   * After the commit: `record.commented` to the record's watchers and the
   * author's other tabs who may read it. Not awaited: the answer doesn't
   * wait for the permission checks, and a failure is logged.
   */
  private pushed(by: Principal, comment: Comment, action: Action) {
    const recordId = comment.recordId;
    void (async () => {
      const keys = [
        ...new Set([
          principalKey(by),
          ...(await this.subscriptions.watchers(this.ref(recordId))),
        ]),
      ].slice(0, MAX_AUDIENCE);
      const audience: { kind: 'user' | 'client'; id: string }[] = [];
      for (const key of keys) {
        const [kind, id] = key.split(':') as ['user' | 'client', string];
        const reader =
          kind === 'user'
            ? await this.activeReader(key, recordId)
            : kind === 'client'
              ? by
              : null;
        if (reader) audience.push({ kind, id });
      }
      this.realtime.toPrincipals(audience, recordCommented, {
        subject: this.record.subject,
        recordId,
        commentId: comment.id,
        action,
      });
    })().catch((error: unknown) =>
      this.logger.warn('A comment was not pushed live', {
        error: String(error),
      }),
    );
  }
}

/** The distinct handles a body mentions (`ada@example.com`, `user:<uuid>`), lower-cased, the first MAX_MENTIONS. */
const handlesOf = (body: string) =>
  [
    ...new Set([...body.matchAll(MENTION)].map((m) => m[1]!.toLowerCase())),
  ].slice(0, MAX_MENTIONS);

/** The addresses among a body's handles. */
const emailHandlesOf = (body: string) =>
  handlesOf(body).filter((handle) => !handle.startsWith('user:'));

/**
 * A comment as the API shows it. `mentionNames` names each mention by its key
 * and, for a mention written as an address, by that address too (as the body
 * has it, lower-cased); an address nobody resolved gets none.
 */
const view = (row: Comment, { names, emails }: Names): CommentView => ({
  id: row.id,
  subject: row.subject,
  recordId: row.recordId,
  author: row.author,
  authorName: names.get(row.author) ?? null,
  body: row.body,
  mentions: row.mentions,
  mentionNames: Object.fromEntries([
    ...row.mentions.map((key) => [key, names.get(key) ?? null] as const),
    ...emailHandlesOf(row.body).flatMap((address) => {
      const key = emails.get(address);
      return key !== undefined && row.mentions.includes(key)
        ? [[address, names.get(key) ?? null] as const]
        : [];
    }),
  ]),
  editedAt: row.editedAt?.toISOString() ?? null,
  parentId: row.parentId,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  resolvedBy: row.resolvedBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const excerpt = (body: string) =>
  body.length > EXCERPT ? `${body.slice(0, EXCERPT - 1)}…` : body;

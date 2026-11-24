import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getColumns,
  gt,
  isNotNull,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { FORM_LIST, FORM_SUBMISSION_LIST } from './forms.list.js';
import {
  formPublicLinks,
  forms,
  formSubmissions,
  formVersions,
} from './forms.tables.js';

type NewForm = typeof forms.$inferInsert;
type NewVersion = typeof formVersions.$inferInsert;
type NewSubmission = typeof formSubmissions.$inferInsert;
type NewPublicLink = typeof formPublicLinks.$inferInsert;

/** A submission row with its version's number. */
const submissionColumns = {
  ...getColumns(formSubmissions),
  version: formVersions.version,
};

/** Only published, active forms: what those who don't edit or read responses see. */
const openToReaders = (publishedOnly: boolean) =>
  publishedOnly
    ? and(eq(forms.status, 'active'), isNotNull(forms.publishedVersion))
    : undefined;

/** Which submissions a reader sees: a form's, only the submitter's own when given. */
export interface SubmissionScope {
  formId: string;
  submittedBy?: string;
}

const ofScope = ({ formId, submittedBy }: SubmissionScope) =>
  and(
    eq(formSubmissions.formId, formId),
    submittedBy === undefined
      ? undefined
      : eq(formSubmissions.submittedBy, submittedBy),
  );

/** A link that works: not revoked, not expired. */
const working = () =>
  and(
    isNull(formPublicLinks.revokedAt),
    gt(formPublicLinks.expiresAt, new Date()),
  );

/**
 * The forms' queries: forms and their versions, submissions and public
 * links, in the caller's transaction and tenant.
 */
@Injectable()
export class FormsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of forms (one row more than the limit), and the total. */
  async page(query: ListQuery, publishedOnly: boolean) {
    const where = and(openToReaders(publishedOnly), FORM_LIST.where(query));
    return Promise.all([
      this.db
        .select()
        .from(forms)
        .where(and(where, afterCursor(forms.id, query)))
        .orderBy(...pageOrder(forms.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, forms, where, query),
    ]);
  }

  async findById(id: string, { publishedOnly = false } = {}) {
    const [row] = await this.db
      .select()
      .from(forms)
      .where(and(eq(forms.id, id), openToReaders(publishedOnly)));
    return row;
  }

  /** The form, locked until the transaction ends. */
  async lock(id: string) {
    const [row] = await this.db
      .select()
      .from(forms)
      .where(eq(forms.id, id))
      .for('update');
    return row;
  }

  async insert(values: NewForm) {
    const [row] = await this.db.insert(forms).values(values).returning();
    return row!;
  }

  async update(id: string, values: Partial<NewForm>) {
    const [row] = await this.db
      .update(forms)
      .set(values)
      .where(eq(forms.id, id))
      .returning();
    return row!;
  }

  /** Replaces the draft while `revision` is still the form's; undefined otherwise. */
  async saveDraft(id: string, revision: number, draft: NewForm['draft']) {
    const [row] = await this.db
      .update(forms)
      .set({ draft, revision: sql`${forms.revision} + 1` })
      .where(and(eq(forms.id, id), eq(forms.revision, revision)))
      .returning();
    return row;
  }

  async delete(id: string) {
    await this.db.delete(forms).where(eq(forms.id, id));
  }

  async insertVersion(values: NewVersion) {
    const [row] = await this.db.insert(formVersions).values(values).returning();
    return row!;
  }

  /** A form's versions, newest first. */
  async versions(formId: string) {
    return this.db
      .select()
      .from(formVersions)
      .where(eq(formVersions.formId, formId))
      .orderBy(desc(formVersions.version));
  }

  async findVersion(formId: string, version: number) {
    const [row] = await this.db
      .select()
      .from(formVersions)
      .where(
        and(eq(formVersions.formId, formId), eq(formVersions.version, version)),
      );
    return row;
  }

  /** Whether `id` is a version of the form. */
  async isVersionOf(formId: string, id: string) {
    const [row] = await this.db
      .select({ id: formVersions.id })
      .from(formVersions)
      .where(and(eq(formVersions.id, id), eq(formVersions.formId, formId)));
    return !!row;
  }

  async insertSubmission(values: NewSubmission) {
    const [row] = await this.db
      .insert(formSubmissions)
      .values(values)
      .returning();
    return row!;
  }

  /** A page of submissions in scope (one row more than the limit), and the total. */
  async submissions(scope: SubmissionScope, query: ListQuery) {
    const where = and(ofScope(scope), FORM_SUBMISSION_LIST.where(query));
    return Promise.all([
      this.db
        .select(submissionColumns)
        .from(formSubmissions)
        .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
        .where(and(where, afterCursor(formSubmissions.id, query)))
        .orderBy(...pageOrder(formSubmissions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, formSubmissions, where, query),
    ]);
  }

  async findSubmission(scope: SubmissionScope, id: string) {
    const [row] = await this.db
      .select(submissionColumns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(and(ofScope(scope), eq(formSubmissions.id, id)));
    return row;
  }

  /** A person's submissions, with their versions' numbers. */
  async submissionsOf(submittedBy: string) {
    return this.db
      .select(submissionColumns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(eq(formSubmissions.submittedBy, submittedBy));
  }

  async deleteSubmissionsOf(submittedBy: string) {
    await this.db
      .delete(formSubmissions)
      .where(eq(formSubmissions.submittedBy, submittedBy));
  }

  /** A form's links, newest first. */
  async links(formId: string) {
    return this.db
      .select()
      .from(formPublicLinks)
      .where(eq(formPublicLinks.formId, formId))
      .orderBy(desc(formPublicLinks.id));
  }

  /** How many of a form's links work now. */
  async countWorkingLinks(formId: string) {
    const [{ open }] = (await this.db
      .select({ open: count() })
      .from(formPublicLinks)
      .where(and(eq(formPublicLinks.formId, formId), working()))) as [
      { open: number },
    ];
    return open;
  }

  async insertLink(values: NewPublicLink) {
    const [row] = await this.db
      .insert(formPublicLinks)
      .values(values)
      .returning();
    return row!;
  }

  /** Revokes a link of the form not yet revoked; undefined when there is none. */
  async revokeLink(formId: string, id: string, revokedBy: string) {
    const [row] = await this.db
      .update(formPublicLinks)
      .set({ revokedAt: new Date(), revokedBy })
      .where(
        and(
          eq(formPublicLinks.id, id),
          eq(formPublicLinks.formId, formId),
          isNull(formPublicLinks.revokedAt),
        ),
      )
      .returning();
    return row;
  }

  /** Takes one submission of a working link's quota; whether there was one left. */
  async takeLinkSubmission(id: string) {
    const [taken] = await this.db
      .update(formPublicLinks)
      .set({
        submissions: sql`${formPublicLinks.submissions} + 1`,
        lastSubmittedAt: new Date(),
      })
      .where(
        and(
          eq(formPublicLinks.id, id),
          working(),
          lt(formPublicLinks.submissions, formPublicLinks.maxSubmissions),
        ),
      )
      .returning({ id: formPublicLinks.id });
    return !!taken;
  }

  /** The working, not used-up link of this token hash, with its form. */
  async findWorkingLink(tokenHash: string) {
    const [found] = await this.db
      .select({ link: formPublicLinks, form: forms })
      .from(formPublicLinks)
      .innerJoin(forms, eq(forms.id, formPublicLinks.formId))
      .where(
        and(
          eq(formPublicLinks.tokenHash, tokenHash),
          working(),
          lt(formPublicLinks.submissions, formPublicLinks.maxSubmissions),
        ),
      );
    return found;
  }
}

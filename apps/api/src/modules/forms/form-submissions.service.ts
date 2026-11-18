import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, getColumns } from 'drizzle-orm';
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
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { checkAnswers } from './form-answers.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import { FORM_SUBMISSION_LIST } from './forms.list.js';
import type { SubmitFormDto } from './forms.schemas.js';
import { type FormRow, formSubmissions, formVersions } from './forms.tables.js';
import { FormsService, invalid } from './forms.service.js';

/** A submission row with its version's number. */
export const submissionColumns = {
  ...getColumns(formSubmissions),
  version: formVersions.version,
};

type SubmissionRow = typeof formSubmissions.$inferSelect & { version: number };

export const submissionView = (row: SubmissionRow) => ({
  id: row.id,
  formId: row.formId,
  versionId: row.versionId,
  version: row.version,
  submittedBy: row.submittedBy,
  status: row.status,
  answers: row.answers,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Submissions (README.md, "Submissions"): answers checked on the server
 * against the exact published version they name, stored with it. Those
 * who may read responses see every submission of a form; a submitter, only
 * their own. The audit log says who submitted what form, never the answers.
 */
@Injectable()
export class FormSubmissionsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly forms: FormsService,
    private readonly sources: FormOptionSourcesService,
    private readonly audit: AuditService,
  ) {}

  async submit(
    principal: RequestPrincipal,
    formId: string,
    dto: SubmitFormDto,
    ip?: string,
  ) {
    const form = await this.forms.find(formId, {
      read: true,
      submit: true,
      edit: false,
      readResponses: false,
    });
    return this.answer({
      principal,
      submittedBy: principalKey(principal),
      form,
      dto,
      ip,
    });
  }

  /**
   * The answers to the published version they name, checked, then stored
   * with their audit entry; `during` runs in the same transaction first (a
   * public link takes its quota there). Without a principal (a public link:
   * `public:<link id>`), the audit's actor is `anonymous`.
   */
  async answer(input: {
    principal: RequestPrincipal | null;
    submittedBy: string;
    form: FormRow;
    dto: SubmitFormDto;
    ip?: string;
    during?: () => Promise<void>;
  }) {
    const { principal, form, dto, ip } = input;
    const current = await this.forms.currentVersion(form);
    if (dto.versionId !== current.id) {
      const [named] = await this.db
        .select({ id: formVersions.id })
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, dto.versionId),
            eq(formVersions.formId, form.id),
          ),
        );
      if (!named) {
        throw invalid([
          { path: 'versionId', message: 'Not a version of this form.' },
        ]);
      }
      throw new ConflictException({
        code: 'form_version_outdated',
        message: `Version ${current.version} replaced the one answered: load it and answer again.`,
        versionId: current.id,
        version: current.version,
      });
    }
    const checked = checkAnswers(current.definition, dto.answers);
    if (!checked.ok) {
      throw invalid(checked.issues);
    }
    // A public link serves no form with a source (form-links.service.ts).
    const sourced = principal
      ? await this.sources.answerIssues(
          principal,
          current.definition,
          checked.answers,
        )
      : [];
    if (sourced.length) {
      throw invalid(sourced);
    }
    const row = await this.txHost.withTransaction(async () => {
      await input.during?.();
      const [created] = await this.db
        .insert(formSubmissions)
        .values({
          formId: form.id,
          versionId: current.id,
          submittedBy: input.submittedBy,
          answers: checked.answers,
        })
        .returning();
      await this.audit.record(principal, {
        action: 'form.submitted',
        targetType: 'form-submission',
        targetId: created!.id,
        // Never the answers: they are the person's.
        details: {
          formId: form.id,
          versionId: current.id,
          version: current.version,
          submittedBy: input.submittedBy,
        },
        ip,
      });
      return created!;
    });
    return submissionView({ ...row, version: current.version });
  }

  /** Every submission for those who read responses; a submitter's own otherwise; a 403 for anyone else. */
  private async scope(principal: RequestPrincipal, formId: string) {
    const rights = await this.forms.rights(principal);
    if (!rights.readResponses && !rights.submit) {
      throw new ForbiddenException();
    }
    await this.forms.find(formId, rights);
    return and(
      eq(formSubmissions.formId, formId),
      rights.readResponses
        ? undefined
        : eq(formSubmissions.submittedBy, principalKey(principal)),
    );
  }

  async page(principal: RequestPrincipal, formId: string, query: ListQuery) {
    const where = and(
      await this.scope(principal, formId),
      FORM_SUBMISSION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
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
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(submissionView) };
  }

  async get(principal: RequestPrincipal, formId: string, id: string) {
    const [row] = await this.db
      .select(submissionColumns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(
        and(await this.scope(principal, formId), eq(formSubmissions.id, id)),
      );
    if (!row) {
      throw new NotFoundException(`Submission ${id} not found.`);
    }
    return submissionView(row);
  }
}

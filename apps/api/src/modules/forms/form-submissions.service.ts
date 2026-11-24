import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { checkAnswers } from './form-answers.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import type { SubmitFormDto } from './forms.schemas.js';
import { FormsRepository } from './forms.repository.js';
import type { FormRow, formSubmissions } from './forms.tables.js';
import { FormsService, invalid } from './forms.service.js';

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
    private readonly repository: FormsRepository,
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
      if (!(await this.repository.isVersionOf(form.id, dto.versionId))) {
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
      const created = await this.repository.insertSubmission({
        formId: form.id,
        versionId: current.id,
        submittedBy: input.submittedBy,
        answers: checked.answers,
      });
      await this.audit.record(principal, {
        action: 'form.submitted',
        targetType: 'form-submission',
        targetId: created.id,
        // Never the answers: they are the person's.
        details: {
          formId: form.id,
          versionId: current.id,
          version: current.version,
          submittedBy: input.submittedBy,
        },
        ip,
      });
      return created;
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
    return {
      formId,
      ...(!rights.readResponses && { submittedBy: principalKey(principal) }),
    };
  }

  async page(principal: RequestPrincipal, formId: string, query: ListQuery) {
    const [rows, total] = await this.repository.submissions(
      await this.scope(principal, formId),
      query,
    );
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(submissionView) };
  }

  async get(principal: RequestPrincipal, formId: string, id: string) {
    const row = await this.repository.findSubmission(
      await this.scope(principal, formId),
      id,
    );
    if (!row) {
      throw new NotFoundException(`Submission ${id} not found.`);
    }
    return submissionView(row);
  }
}

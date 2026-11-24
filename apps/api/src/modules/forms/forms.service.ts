import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { defaultIssue } from './form-answers.js';
import {
  definitionIssues,
  EMPTY_DEFINITION,
  fieldsOf,
  type FormDefinition,
  keyTypesOf,
  type SchemaIssue,
} from './form-definition.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import { FormPolicy } from './forms.policy.js';
import { FormsRepository } from './forms.repository.js';
import type {
  CreateFormDto,
  PublishFormDto,
  SaveDraftDto,
  UpdateFormDto,
} from './forms.schemas.js';
import type { FormRow, FormVersionRow } from './forms.tables.js';

export const invalid = (errors: SchemaIssue[], prefix = '') =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors: errors.map((issue) => ({
      path: [prefix, issue.path].filter(Boolean).join('.'),
      message: issue.message,
    })),
  });

const slugTaken = (slug: string) =>
  new ConflictException({
    code: 'form_slug_taken',
    message: `A form named "${slug}" exists.`,
    errors: [{ path: 'slug', message: `"${slug}" is taken.` }],
  });

const conflict = (form: FormRow) =>
  new ConflictException({
    code: 'form_conflict',
    message:
      'The form changed since you read it: read it again, then retry with its revision.',
    revision: form.revision,
  });

export const versionView = (row: FormVersionRow) => ({
  id: row.id,
  formId: row.formId,
  version: row.version,
  definition: row.definition,
  publishedAt: row.publishedAt.toISOString(),
});

/** What a draft or a published definition must pass beyond its shape. */
const issuesOf = (
  definition: FormDefinition,
  keyTypes: Record<string, string>,
) => definitionIssues(definition, keyTypes, defaultIssue);

/** Who may do what, once per request: the four rights are independent (forms.policy.ts). */
export interface FormRights {
  read: boolean;
  submit: boolean;
  edit: boolean;
  readResponses: boolean;
}

/** Only published, active forms, unless they edit or read responses. */
const publishedOnly = (rights: FormRights) =>
  !rights.edit && !rights.readResponses;

/**
 * Runtime forms (README.md): drafts edited with optimistic
 * concurrency (`revision`), published as immutable versions, archived
 * rather than deleted once published. Every change is audited, without
 * the definition itself (its size; the versions keep it).
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly repository: FormsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    private readonly policy: FormPolicy,
    private readonly sources: FormOptionSourcesService,
  ) {}

  async rights(principal: RequestPrincipal): Promise<FormRights> {
    const [read, submit, edit, readResponses] = await Promise.all([
      this.policy.read(principal),
      this.policy.submit(principal),
      this.policy.edit(principal),
      this.policy.readResponses(principal),
    ]);
    return { read, submit, edit, readResponses };
  }

  private view(row: FormRow, rights: FormRights) {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: row.status,
      revision: row.revision,
      publishedVersion: row.publishedVersion,
      ...(rights.edit && {
        hasDraftChanges: row.publishedRevision !== row.revision,
      }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Editors see every form; anyone else with a right on forms, the published active ones. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const rights = await this.rights(principal);
    if (!Object.values(rights).some(Boolean)) {
      throw new ForbiddenException();
    }
    const [rows, total] = await this.repository.page(
      query,
      publishedOnly(rights),
    );
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map((row) => this.view(row, rights)) };
  }

  async get(principal: RequestPrincipal, id: string) {
    const rights = await this.rights(principal);
    return this.view(await this.find(id, rights), rights);
  }

  /**
   * The form as `rights` may see it, or a 404 (another tenant's is
   * invisible: row-level security), or a 403 with no right on forms.
   * Editors and response readers see archived and unpublished ones.
   */
  async find(id: string, rights: FormRights) {
    if (!Object.values(rights).some(Boolean)) {
      throw new ForbiddenException();
    }
    const row = await this.repository.findById(id, {
      publishedOnly: publishedOnly(rights),
    });
    if (!row) {
      throw new NotFoundException(`Form ${id} not found.`);
    }
    return row;
  }

  async create(principal: RequestPrincipal, dto: CreateFormDto, ip?: string) {
    const definition = dto.definition ?? EMPTY_DEFINITION;
    const issues = issuesOf(definition, {});
    if (issues.length) {
      throw invalid(issues, 'definition');
    }
    const row = await this.txHost.withTransaction(async () => {
      const created = await this.repository
        .insert({
          slug: dto.slug,
          name: dto.name,
          description: dto.description ?? null,
          draft: definition,
        })
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? slugTaken(dto.slug)
            : error;
        });
      await this.audit.record(principal, {
        action: 'form.created',
        targetType: 'form',
        targetId: created.id,
        details: { slug: dto.slug, name: dto.name },
        ip,
      });
      return created;
    });
    return this.view(row, await this.rights(principal));
  }

  /** The name, slug and description: not versioned, they apply at once. */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateFormDto,
    ip?: string,
  ) {
    const current = await this.editable(principal, id);
    const changes = Object.fromEntries(
      Object.entries(dto).filter(
        ([key, value]) =>
          value !== undefined && value !== current[key as keyof FormRow],
      ),
    ) as UpdateFormDto;
    if (Object.keys(changes).length === 0) {
      return this.view(current, await this.rights(principal));
    }
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository
        .update(id, changes)
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? slugTaken(changes.slug!)
            : error;
        });
      await this.audit.record(principal, {
        action: 'form.updated',
        targetType: 'form',
        targetId: id,
        details: Object.fromEntries(
          Object.keys(changes).map((key) => [
            key,
            {
              from: current[key as keyof FormRow],
              to: changes[key as keyof UpdateFormDto],
            },
          ]),
        ),
        ip,
      });
      return updated;
    });
    return this.view(row, await this.rights(principal));
  }

  async draft(principal: RequestPrincipal, id: string) {
    const form = await this.editable(principal, id);
    return { formId: form.id, revision: form.revision, definition: form.draft };
  }

  /**
   * Replaces the draft when `revision` is still the form's (one statement:
   * two editors can't both win), checked as a publication would check it.
   */
  async saveDraft(
    principal: RequestPrincipal,
    id: string,
    dto: SaveDraftDto,
    ip?: string,
  ) {
    const form = await this.editable(principal, id);
    if (form.revision !== dto.revision) {
      throw conflict(form);
    }
    const issues = [
      ...issuesOf(dto.definition, form.keyTypes),
      ...(await this.sources.issues(principal, dto.definition)),
    ];
    if (issues.length) {
      throw invalid(issues, 'definition');
    }
    const row = await this.txHost.withTransaction(async () => {
      const saved = await this.repository.saveDraft(
        id,
        dto.revision,
        dto.definition,
      );
      if (!saved) {
        throw conflict((await this.find(id, { ...NO_RIGHTS, edit: true }))!);
      }
      await this.audit.record(principal, {
        action: 'form.draft-saved',
        targetType: 'form',
        targetId: id,
        details: {
          revision: saved.revision,
          fields: fieldsOf(dto.definition).length,
        },
        ip,
      });
      return saved;
    });
    return { formId: row.id, revision: row.revision, definition: row.draft };
  }

  /**
   * Publishes the draft of `revision` as the next version, in one
   * transaction with the form locked: a concurrent save or publication
   * waits, then finds the revision moved (409 form_conflict) or nothing
   * new (409 form_unchanged).
   */
  async publish(
    principal: RequestPrincipal,
    id: string,
    dto: PublishFormDto,
    ip?: string,
  ) {
    await this.editable(principal, id);
    const version = await this.txHost.withTransaction(async () => {
      const form = await this.repository.lock(id);
      if (!form) {
        throw new NotFoundException(`Form ${id} not found.`);
      }
      if (form.revision !== dto.revision) {
        throw conflict(form);
      }
      if (form.status === 'archived') {
        throw new ConflictException({
          code: 'form_archived',
          message: 'The form is archived: unarchive it to publish.',
        });
      }
      if (form.publishedRevision === form.revision) {
        throw new ConflictException({
          code: 'form_unchanged',
          message: `Version ${form.publishedVersion} is this draft already.`,
        });
      }
      const issues = [
        ...issuesOf(form.draft, form.keyTypes),
        // A source unregistered, or the editor's right to it gone, since the save.
        ...(await this.sources.issues(principal, form.draft)),
      ];
      if (fieldsOf(form.draft).length === 0) {
        issues.push({
          path: 'sections',
          message: 'A form needs a field to be published.',
        });
      }
      if (issues.length) {
        throw invalid(issues, 'definition');
      }
      const number = (form.publishedVersion ?? 0) + 1;
      const created = await this.repository.insertVersion({
        formId: id,
        version: number,
        definition: form.draft,
      });
      await this.repository.update(id, {
        publishedVersion: number,
        publishedRevision: form.revision,
        keyTypes: { ...form.keyTypes, ...keyTypesOf(form.draft) },
      });
      await this.audit.record(principal, {
        action: 'form.published',
        targetType: 'form',
        targetId: id,
        details: {
          version: number,
          versionId: created.id,
          revision: form.revision,
          fields: fieldsOf(form.draft).length,
        },
        ip,
      });
      return created;
    });
    return versionView(version);
  }

  /** Archived: no submissions, hidden from submitters; its versions and submissions stay. */
  async setStatus(
    principal: RequestPrincipal,
    id: string,
    status: FormRow['status'],
    ip?: string,
  ) {
    const form = await this.editable(principal, id);
    if (form.status === status) {
      return this.view(form, await this.rights(principal));
    }
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository.update(id, { status });
      await this.audit.record(principal, {
        action: status === 'archived' ? 'form.archived' : 'form.unarchived',
        targetType: 'form',
        targetId: id,
        ip,
      });
      return updated;
    });
    return this.view(row, await this.rights(principal));
  }

  /** Only a form never published: a published one is archived (its versions and answers stay). */
  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const form = await this.editable(principal, id);
    if (form.publishedVersion !== null) {
      throw new ConflictException({
        code: 'form_published',
        message: 'A published form is archived, not deleted.',
      });
    }
    await this.txHost.withTransaction(async () => {
      await this.repository.delete(id);
      await this.audit.record(principal, {
        action: 'form.deleted',
        targetType: 'form',
        targetId: id,
        details: { slug: form.slug, name: form.name },
        ip,
      });
    });
  }

  /** The published versions, newest first: for anyone who may see the form. */
  async versions(principal: RequestPrincipal, id: string) {
    await this.find(id, await this.rights(principal));
    const rows = await this.repository.versions(id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        formId: row.formId,
        version: row.version,
        publishedAt: row.publishedAt.toISOString(),
        fieldCount: fieldsOf(row.definition).length,
      })),
    };
  }

  async version(principal: RequestPrincipal, id: string, version: number) {
    await this.find(id, await this.rights(principal));
    const row = await this.repository.findVersion(id, version);
    if (!row) {
      throw new NotFoundException(
        `Version ${version} of form ${id} not found.`,
      );
    }
    return versionView(row);
  }

  /** The version submitters fill in now, with the form's name: what a renderer shows. */
  async published(principal: RequestPrincipal, id: string) {
    const rights = await this.rights(principal);
    // Whoever has a right on forms sees what submitters see: editors preview it too.
    const form = await this.find(id, {
      ...NO_RIGHTS,
      read: Object.values(rights).some(Boolean),
    });
    const version = await this.currentVersion(form);
    return {
      formId: form.id,
      slug: form.slug,
      name: form.name,
      description: form.description,
      versionId: version.id,
      version: version.version,
      definition: version.definition,
      publishedAt: version.publishedAt.toISOString(),
    };
  }

  /** The option sources an editor may give a field (README.md, "Option sources"). */
  async optionSources(principal: RequestPrincipal) {
    if (!(await this.policy.edit(principal))) {
      throw new ForbiddenException();
    }
    return this.sources.usable(principal);
  }

  /** A published field's choices from its source, for whoever may fill the form in. */
  async sourceOptions(
    principal: RequestPrincipal,
    id: string,
    key: string,
    query: { q?: string; limit?: number },
  ) {
    const rights = await this.rights(principal);
    const form = await this.find(id, {
      ...NO_RIGHTS,
      read: Object.values(rights).some(Boolean),
    });
    const version = await this.currentVersion(form);
    return this.sources.options(principal, version.definition, key, query);
  }

  /** The published version of a form that has one. */
  async currentVersion(form: FormRow) {
    const version = await this.repository.findVersion(
      form.id,
      form.publishedVersion ?? 0,
    );
    if (!version) {
      throw new NotFoundException(`Form ${form.id} is not published.`);
    }
    return version;
  }

  /** The form, for an editor: a 403 without `edit`, a 404 when it isn't there. */
  async editable(principal: RequestPrincipal, id: string) {
    if (!(await this.policy.edit(principal))) {
      throw new ForbiddenException();
    }
    return this.find(id, { ...NO_RIGHTS, edit: true });
  }
}

const NO_RIGHTS: FormRights = {
  read: false,
  submit: false,
  edit: false,
  readResponses: false,
};

import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService, t } from '@nestjs/i18n';
import { StorageDisk } from '@nestjs/storage';
import { type Queue, UnrecoverableError } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { type PageQuery, toPage } from '../../core/http/pagination.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { PeopleService } from '../people/people.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { recordView } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { tenantFileKey } from '../storage/storage.keys.js';
import { StoredFiles } from '../storage/storage.release.js';
import { DocumentTemplates } from './document-templates.js';
import { documentFailed, documentReady } from './documents.events.js';
import { documentsConfig } from './documents.config.js';
import type { DocumentView, RecordDocumentView } from './documents.schemas.js';
import { DocumentSources } from './documents.source.js';
import { DocumentsRepository } from './documents.repository.js';
import type { DocumentRow, DocumentStatus } from './documents.tables.js';
import { PdfRejectedError, PdfRenderer } from './pdf-renderer.js';

/** The queue of documents to render. */
export const DOCUMENTS = 'documents';

/**
 * What a queued render carries: the document, who asked (checked again
 * when it runs), and the tenant both are in (the worker renders in it, and
 * nowhere else).
 */
export interface DocumentJob extends TenantEnvelope {
  readonly tenantId: string;
  id: string;
  principal: RequestPrincipal;
}

/** Why a document failed: the codes of `documents.errors` in the catalog. */
export const DOCUMENT_ERRORS = {
  principalGone: 'principalGone',
  recordGone: 'recordGone',
  rejected: 'rejected',
  unavailable: 'unavailable',
} as const;
type DocumentError = (typeof DOCUMENT_ERRORS)[keyof typeof DOCUMENT_ERRORS];

/** The states a render may claim, and fail from. */
const OPEN: DocumentStatus[] = ['queued', 'rendering'];

/** A document that can't be issued, for a reason people can act on: not retried. */
class DocumentFailure extends Error {
  constructor(readonly code: DocumentError) {
    super(code);
  }
}

/**
 * This run lost its claim to another one, which goes on: the job stops
 * without retries, and its failure must not fail the document (the
 * processor's `failed` handler skips it).
 */
export class DocumentClaimLost extends UnrecoverableError {}

/** Another run claimed the document since this one did. */
class ClaimLost extends Error {
  constructor(id: string) {
    super(`Document ${id} is held by another run: this one stops.`);
  }
}

/**
 * Where a run's PDF is on the private disk: one key per run, never shared,
 * under its tenant's prefix.
 */
export const documentKey = (tenantId: string, id: string, runToken: string) =>
  tenantFileKey(tenantId, `documents/${id}/${runToken}.pdf`);

/**
 * Documents issued for records: the template of the record's
 * `forRecord()` is filled with the fields the requester may read, a queue
 * job renders the PDF (Gotenberg, on the workers), and the transaction that
 * completes the job links the file on the private disk. Issued documents
 * never change; asking again issues a new one. The requester hears
 * `document.ready` (or `document.failed`) over realtime; anyone who may
 * read the record follows it at GET /v1/documents/{id}.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger('Documents');

  constructor(
    private readonly repository: DocumentsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @InjectQueue(DOCUMENTS) private readonly queue: Queue<DocumentJob>,
    private readonly sources: DocumentSources,
    private readonly records: Records,
    private readonly templates: DocumentTemplates,
    private readonly renderer: PdfRenderer,
    private readonly disk: StorageDisk,
    private readonly files: StoredFiles,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly people: PeopleService,
    private readonly realtime: Realtime,
    private readonly i18n: I18nService,
    @Inject(documentsConfig.KEY)
    private readonly config: ConfigType<typeof documentsConfig>,
  ) {}

  /**
   * Asks for a document of a record: checked now (the record readable),
   * rendered by a worker. 503 `documents_unavailable` while GOTENBERG_URL is
   * unset; 409 `document_pending` while the same requester's document of the
   * record, in the same language, is queued or rendering (one at a time: the
   * partial unique index decides a race).
   */
  async request(
    principal: RequestPrincipal,
    request: {
      subject: string;
      recordId: string;
      locale: string;
      ip?: string;
    },
  ) {
    if (!this.renderer.enabled) {
      throw new ServiceUnavailableException({
        code: 'documents_unavailable',
        message: t('documents.unavailable'),
      });
    }
    const source = this.sources.of(request.subject);
    // A 404 for a record the requester may not read.
    await this.records
      .of(request.subject)
      .store.findOne(request.recordId, { visibleTo: principal });
    const tenantId = requireTenantId('A document');
    if (principal.tenantId !== tenantId) {
      // A bug, never a caller's choice: the render would run in another tenant.
      throw new Error("A document is rendered in its requester's tenant only.");
    }
    const timezone =
      (principal.kind === 'user' ? principal.timezone : null) ?? 'UTC';
    const pending = {
      source: source.record.path,
      recordId: request.recordId,
      requestedBy: principalKey(principal),
      locale: request.locale,
    };
    const row = await this.txHost
      .withTransaction(async () => {
        const row = await this.repository.insert({
          ...pending,
          template: source.template.name,
          subject: request.subject,
          timezone,
          status: 'queued',
        });
        await this.audit.record(principal, {
          action: 'document.requested',
          targetType: 'document',
          targetId: row.id,
          details: {
            source: pending.source,
            subject: request.subject,
            recordId: request.recordId,
            locale: request.locale,
          },
          ip: request.ip,
        });
        return row;
      })
      .catch(async (error: unknown) => {
        if (databaseErrorKind(error) !== 'unique_violation') throw error;
        const open = await this.repository.findOpen(pending, OPEN);
        throw new ConflictException({
          code: 'document_pending',
          message: t('documents.pending'),
          id: open?.id,
        });
      });
    try {
      await this.queue.add(
        pending.source,
        { id: row.id, principal, tenantId },
        {
          // The document's id: a job is queued once per document.
          jobId: row.id,
          attempts: this.config.renderAttempts,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
    } catch (error) {
      await this.fail(
        { id: row.id, principal, tenantId },
        DOCUMENT_ERRORS.unavailable,
      );
      throw error;
    }
    return { id: row.id, status: 'queued' as const };
  }

  /**
   * A page of a record's documents, newest first: in progress, issued and
   * failed. A 404 unless the principal may read the record.
   */
  async list(
    principal: Principal,
    subject: string,
    recordId: string,
    query: PageQuery,
  ) {
    await this.records.of(subject).store.findOne(recordId, {
      visibleTo: principal,
    });
    const rows = await this.repository.ofRecord(subject, recordId, query);
    const page = toPage(rows, query);
    const names = await this.people.names(
      page.items.map((row) => row.requestedBy),
    );
    return {
      ...page,
      items: page.items.map((row) => listed(row, names.get(row.requestedBy))),
    };
  }

  /**
   * A document of a record the principal may read, or a 404: every field it
   * shows too (field-level permissions).
   */
  async status(principal: Principal, id: string): Promise<DocumentView> {
    return view(await this.readable(principal, id));
  }

  /**
   * A short-lived link to the issued PDF, for a principal who may read the
   * record and every field the PDF shows now: else a 404. `inline` shows it
   * in the browser.
   */
  async downloadUrl(principal: Principal, id: string, inline: boolean) {
    const row = await this.readable(principal, id);
    if (row.status !== 'completed' || !row.fileKey) {
      throw new NotFoundException(t('documents.notReady'));
    }
    return this.disk.signedUrl(row.fileKey, {
      expiresIn: '5m',
      filename: row.fileName ?? 'document.pdf',
      disposition: inline ? 'inline' : 'attachment',
    });
  }

  private async readable(principal: Principal, id: string) {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException(t('documents.notFound'));
    try {
      const found = await this.records
        .of(row.subject)
        .store.findOne(row.recordId, { visibleTo: principal });
      // Every field it shows, on this record (a conditional permission too).
      if (
        !(await this.attachments.showsFields(
          principal,
          row.subject,
          found as Record<string, unknown>,
          row.fields,
        ))
      ) {
        throw new NotFoundException();
      }
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(t('documents.notFound'));
      }
      throw error;
    }
    return row;
  }

  /**
   * The values the template reads: the record's fields as the requester may
   * read them now (field-level access applied), formatted for the document's
   * language and time zone. A record gone or no longer theirs fails the
   * document.
   */
  private async content(principal: RequestPrincipal, row: DocumentRow) {
    const { store, presenter, declaration } = this.records.of(row.subject);
    let shown: Record<string, unknown>;
    try {
      const found = await store.findOne(row.recordId, {
        visibleTo: principal,
      });
      shown = await presenter.one(
        principal,
        recordView(declaration, found) as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new DocumentFailure(DOCUMENT_ERRORS.recordGone);
      }
      throw error;
    }
    const format = new Intl.DateTimeFormat(row.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: row.timezone,
    });
    const show = (value: unknown): string =>
      typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)
        ? format.format(new Date(value))
        : typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    const record: Record<string, string | null> = {};
    for (const name of Object.keys(declaration.fields)) {
      // A field the requester may not read is not in `shown`: not in the PDF.
      if (name in shown) {
        record[name] = shown[name] == null ? null : show(shown[name]);
      }
    }
    const title =
      Object.values(record).find((value) => value !== null) ?? declaration.noun;
    return {
      title,
      fields: Object.keys(record),
      context: {
        title,
        record,
        rows: Object.entries(record)
          .filter(([, value]) => value !== null && value !== title)
          .map(([name, value]) => ({ label: humanize(name), value })),
        labels: {
          document: this.i18n.t('documents.labels.document', {
            locale: row.locale,
            args: { noun: declaration.noun },
          }),
          issued: this.i18n.t('documents.labels.issued', {
            locale: row.locale,
            args: { date: format.format(new Date()) },
          }),
        },
      },
    };
  }

  /**
   * On the worker: renders the document and issues it.
   *
   * Each run claims the document with a token of its own (queued or
   * rendering → rendering, its token), writes its PDF under its own key,
   * and completes the document only while it still holds the claim. A run
   * started twice (a stalled job picked up again while the first still
   * runs) thus issues one PDF: the later claim wins, the other run finds its
   * claim gone, deletes its own file and stops. A document already issued is
   * left as it is; a failed one isn't rendered again. Errors a retry can't
   * fix are UnrecoverableError; the others are retried
   * (DOCUMENTS_RENDER_ATTEMPTS), then the document fails.
   */
  async issue(
    job: DocumentJob,
    principal: RequestPrincipal | null,
    attempt: { final: boolean },
  ): Promise<DocumentView> {
    const token = randomUUID();
    const row = await this.repository.updateIn(job.id, OPEN, {
      status: 'rendering',
      runToken: token,
    });
    if (!row) {
      const now = await this.repository.findById(job.id);
      if (now?.status === 'completed') return view(now); // issued by an earlier run
      throw new UnrecoverableError(
        `Document ${job.id} is ${now ? now.status : 'gone'}: not rendered.`,
      );
    }
    const key = documentKey(row.tenantId, row.id, token);
    let written = false;
    try {
      if (!principal) throw new DocumentFailure(DOCUMENT_ERRORS.principalGone);
      const source = this.sources.of(row.subject);
      const issuedAt = new Date();
      const content = await this.content(principal, row);
      const html = await this.templates.render(
        source.template,
        content.context,
        { locale: row.locale, title: content.title },
      );
      const pdf = await this.renderer.render(html, { trace: row.id });
      written = true;
      await this.disk.put(key, pdf, { contentType: 'application/pdf' });
      const fields = [...content.fields].sort();
      const fileName = `${fileNameOf(content.title)}.pdf`;
      const record = { subject: row.subject, recordId: row.recordId };
      const issued = await this.txHost.withTransaction(async () => {
        // The PDF becomes a locked attachment of the record, in the same
        // transaction: a lost claim rolls it back with the rest.
        const attachment = await this.attachments.attachStored(
          principal,
          record,
          {
            key,
            name: fileName,
            size: pdf.length,
            contentType: 'application/pdf',
          },
          { locked: true, fields },
        );
        const issued = await this.repository.updateIn(
          row.id,
          ['rendering'],
          {
            status: 'completed',
            fileKey: key,
            fileName,
            attachmentId: attachment.id,
            size: pdf.length,
            fields,
            issuedAt,
            error: null,
          },
          token,
        );
        if (!issued) throw new ClaimLost(row.id);
        await this.audit.record(principal, {
          action: 'document.issued',
          targetType: 'document',
          targetId: row.id,
          details: {
            source: row.source,
            subject: row.subject,
            recordId: row.recordId,
            fields,
            size: pdf.length,
          },
        });
        return issued;
      });
      this.attachments.changed(
        principal,
        record,
        issued.attachmentId!,
        'added',
        fields,
      );
      written = false; // issued: the file is the document's now
      // After the commit: a client never hears of a document that rolled back.
      this.realtime.toPrincipal(principal, documentReady, {
        id: issued.id,
        subject: issued.subject,
        recordId: issued.recordId,
        attachmentId: issued.attachmentId!,
      });
      this.logger.log('Document issued', {
        id: issued.id,
        source: issued.source,
        size: pdf.length,
      });
      return view(issued);
    } catch (error) {
      // This run's own file, never another's: nothing points at it.
      if (written) await this.disk.delete(key).catch(() => undefined);
      if (error instanceof ClaimLost) {
        this.logger.warn(
          'A document render lost its claim: another run holds it',
          { id: row.id },
        );
        throw new DocumentClaimLost(error.message);
      }
      const final =
        attempt.final ||
        error instanceof UnrecoverableError ||
        error instanceof DocumentFailure;
      this.logger.warn(
        final ? 'A document failed' : 'A document render failed: retrying',
        { id: row.id, error: String(error) },
      );
      if (final) {
        await this.fail(job, reasonOf(error), principal ?? undefined, token);
      }
      throw error instanceof DocumentFailure
        ? new UnrecoverableError(error.message)
        : error;
    }
  }

  /**
   * A document that failed for good: its state and its audit entry in one
   * transaction, then the requester told. Idempotent: only a queued or
   * rendering document fails (with `runToken`, only while that run holds
   * it), so a second call (the worker's failed event after `issue()`'s own)
   * changes, audits and tells nothing.
   */
  async fail(
    job: DocumentJob,
    reason: DocumentError,
    principal: Pick<Principal, 'kind' | 'id'> = job.principal,
    runToken?: string,
  ) {
    const failed = await this.txHost.withTransaction(async () => {
      const failed = await this.repository.updateIn(
        job.id,
        OPEN,
        { status: 'failed', error: reason },
        runToken,
      );
      if (failed) {
        await this.audit.record(principal as Principal, {
          action: 'document.failed',
          targetType: 'document',
          targetId: failed.id,
          details: {
            source: failed.source,
            subject: failed.subject,
            recordId: failed.recordId,
            error: reason,
          },
        });
      }
      return failed;
    });
    if (!failed) return; // issued, failed already, or held by another run
    this.realtime.toPrincipal(principal as Principal, documentFailed, {
      id: failed.id,
      subject: failed.subject,
      recordId: failed.recordId,
      error: reason,
    });
  }

  /**
   * Records are going for good (DocumentsExtension.purged): their documents
   * go with them, in the purge's transaction, and their files once it
   * commits (StoredFiles); a rollback keeps both.
   */
  async forget(subject: string, ids: readonly string[]) {
    await this.files.release(
      await this.repository.deleteOfRecords(subject, ids),
    );
  }
}

const reasonOf = (error: unknown): DocumentError =>
  error instanceof DocumentFailure
    ? error.code
    : error instanceof PdfRejectedError
      ? DOCUMENT_ERRORS.rejected
      : DOCUMENT_ERRORS.unavailable;

/** `publishedAt` → `Published at`: a field's name as a row label. */
const humanize = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
};

/** A title as a file name: no path separators or control characters, at most 100. */
const fileNameOf = (title: string) =>
  Array.from(title)
    .map((char) =>
      char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char,
    )
    .join('')
    .trim()
    .slice(0, 100) || 'document';

/** A document as a record's documents list shows it. */
const listed = (
  row: DocumentRow,
  issuedByName: string | null = null,
): RecordDocumentView => ({
  id: row.id,
  status: row.status,
  template: row.template,
  language: row.locale,
  issuedBy: row.requestedBy,
  issuedByName,
  createdAt: row.createdAt.toISOString(),
  finishedAt:
    row.status === 'completed'
      ? (row.issuedAt ?? row.updatedAt).toISOString()
      : row.status === 'failed'
        ? row.updatedAt.toISOString()
        : null,
  error: row.error ? t(`documents.errors.${row.error}`) : null,
  errorCode: row.error,
});

const view = (row: DocumentRow): DocumentView => ({
  id: row.id,
  source: row.source,
  subject: row.subject,
  recordId: row.recordId,
  locale: row.locale,
  status: row.status,
  fileName: row.fileName,
  attachmentId: row.attachmentId,
  size: row.size,
  error: row.error ? t(`documents.errors.${row.error}`) : null,
  errorCode: row.error,
  issuedAt: row.issuedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

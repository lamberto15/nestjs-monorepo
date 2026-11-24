import { NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { Records } from '../records/records.service.js';
import { StoredFiles } from '../storage/storage.release.js';
import { DocumentsRepository } from './documents.repository.js';
import {
  DOCUMENT_ERRORS,
  DOCUMENTS,
  DocumentsService,
} from './documents.service.js';

/** DocumentsService's rules on a stubbed repository: no database, no renderer. */
describe('DocumentsService', () => {
  const repository = {
    findById: vi.fn(),
    updateIn: vi.fn(),
    deleteOfRecords: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const realtime = { toPrincipal: vi.fn() };
  const store = { findOne: vi.fn() };
  const attachments = { showsFields: vi.fn() };
  const files = { release: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const job = { id: 'd1', principal: user, tenantId: 't1' };
  const document = {
    id: 'd1',
    source: 'notes',
    subject: 'Note',
    recordId: 'r1',
    status: 'queued',
    fields: ['title'],
    fileKey: null,
    error: null,
    issuedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: DocumentsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: DocumentsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: Realtime, useValue: realtime },
        { provide: Records, useValue: { of: () => ({ store }) } },
        { provide: AttachmentsService, useValue: attachments },
        { provide: StoredFiles, useValue: files },
        { provide: getQueueToken(DOCUMENTS), useValue: {} },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Sources, templates, renderer, disk, people, i18n and config: unused here.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(DocumentsService);
  });

  it('answers 404 when the principal may not read every field the document shows', async () => {
    repository.findById.mockResolvedValue(document);
    store.findOne.mockResolvedValue({ id: 'r1' });
    attachments.showsFields.mockResolvedValue(false);
    await expect(service.status(user, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('gives no link to a document not yet issued', async () => {
    repository.findById.mockResolvedValue(document);
    store.findOne.mockResolvedValue({ id: 'r1' });
    attachments.showsFields.mockResolvedValue(true);
    await expect(service.downloadUrl(user, 'd1', false)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('renders an unclaimable document only when an earlier run issued it', async () => {
    repository.updateIn.mockResolvedValue(undefined);
    repository.findById.mockResolvedValue({
      ...document,
      status: 'completed',
    });
    await expect(
      service.issue(job, user, { final: false }),
    ).resolves.toMatchObject({ id: 'd1', status: 'completed' });

    repository.findById.mockResolvedValue({ ...document, status: 'failed' });
    await expect(
      service.issue(job, user, { final: false }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('fails a document once, held by the run that fails it', async () => {
    repository.updateIn.mockResolvedValueOnce(document);
    await service.fail(job, DOCUMENT_ERRORS.rejected, user, 'token');
    expect(repository.updateIn).toHaveBeenCalledWith(
      'd1',
      ['queued', 'rendering'],
      { status: 'failed', error: DOCUMENT_ERRORS.rejected },
      'token',
    );
    expect(realtime.toPrincipal).toHaveBeenCalledTimes(1);

    repository.updateIn.mockResolvedValueOnce(undefined);
    await service.fail(job, DOCUMENT_ERRORS.rejected, user);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("releases the files of forgotten records' documents", async () => {
    repository.deleteOfRecords.mockResolvedValue(['k1']);
    await service.forget('Note', ['r1']);
    expect(files.release).toHaveBeenCalledWith(['k1']);
  });
});

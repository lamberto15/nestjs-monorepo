import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { FormOptionSourcesService } from './form-option-sources.service.js';
import { FormPolicy } from './forms.policy.js';
import { FormsRepository } from './forms.repository.js';
import { FormsService } from './forms.service.js';

/** FormsService's rules on a stubbed repository: no database. */
describe('FormsService', () => {
  const repository = {
    page: vi.fn(),
    findById: vi.fn(),
    lock: vi.fn(),
    update: vi.fn(),
    saveDraft: vi.fn(),
    insertVersion: vi.fn(),
    delete: vi.fn(),
  };
  const policy = {
    read: vi.fn(),
    submit: vi.fn(),
    edit: vi.fn(),
    readResponses: vi.fn(),
  };
  const sources = { issues: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const definition = {
    sections: [
      {
        key: 's',
        title: 'S',
        fields: [{ key: 'a', type: 'text', label: 'A' }],
      },
    ],
  };
  const form = {
    id: 'f1',
    slug: 'intake',
    name: 'Intake',
    status: 'active',
    revision: 2,
    publishedRevision: 1,
    publishedVersion: 1,
    draft: definition,
    keyTypes: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let service: FormsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    sources.issues.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        FormsService,
        { provide: FormsRepository, useValue: repository },
        { provide: FormPolicy, useValue: policy },
        { provide: FormOptionSourcesService, useValue: sources },
        { provide: AuditService, useValue: audit },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(FormsService);
  });

  it('shows readers only published, active forms; 403 without a right', async () => {
    policy.read.mockResolvedValue(true);
    repository.page.mockResolvedValue([[], 0]);
    await service.page(user, { limit: 20 } as never);
    expect(repository.page).toHaveBeenCalledWith({ limit: 20 }, true);

    policy.read.mockResolvedValue(false);
    await expect(
      service.page(user, { limit: 20 } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a draft saved on a stale revision', async () => {
    policy.edit.mockResolvedValue(true);
    repository.findById.mockResolvedValue(form);
    await expect(
      service.saveDraft(user, 'f1', { revision: 1, definition } as never),
    ).rejects.toMatchObject({ response: { code: 'form_conflict' } });
    expect(repository.saveDraft).not.toHaveBeenCalled();
  });

  it('publishes nothing new: 409 form_unchanged', async () => {
    policy.edit.mockResolvedValue(true);
    repository.findById.mockResolvedValue(form);
    repository.lock.mockResolvedValue({ ...form, publishedRevision: 2 });
    await expect(
      service.publish(user, 'f1', { revision: 2 }),
    ).rejects.toMatchObject({ response: { code: 'form_unchanged' } });
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });

  it('publishes the draft as the next version', async () => {
    policy.edit.mockResolvedValue(true);
    repository.findById.mockResolvedValue(form);
    repository.lock.mockResolvedValue(form);
    repository.insertVersion.mockImplementation((values) => ({
      id: 'v2',
      publishedAt: new Date(0),
      ...values,
    }));
    await expect(
      service.publish(user, 'f1', { revision: 2 }),
    ).resolves.toMatchObject({ id: 'v2', version: 2 });
    expect(repository.update).toHaveBeenCalledWith(
      'f1',
      expect.objectContaining({ publishedVersion: 2, publishedRevision: 2 }),
    );
  });

  it('archives a published form rather than deleting it', async () => {
    policy.edit.mockResolvedValue(true);
    repository.findById.mockResolvedValue(form);
    await expect(service.remove(user, 'f1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.delete).not.toHaveBeenCalled();
  });
});

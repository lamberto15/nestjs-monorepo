import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { AuthorizationService } from '@nestjs/authorization';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { CustomFieldsRepository } from './custom-fields.repository.js';
import {
  CUSTOM_CAPABILITY,
  CustomFieldsService,
  MAX_ACTIVE_FIELDS,
} from './custom-fields.service.js';

/** CustomFieldsService's rules on a stubbed repository: no database. */
describe('CustomFieldsService', () => {
  const repository = {
    definitions: vi.fn(),
    findById: vi.fn(),
    lastPosition: vi.fn(),
    countActive: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    holdsValues: vi.fn(),
    valueCounts: vi.fn(),
  };
  const authorization = { can: vi.fn(), authorize: vi.fn() };
  const audit = { record: vi.fn() };
  const invoice = {
    declaration: { subject: 'Invoice', noun: 'invoice' },
    extensions: [{ capability: CUSTOM_CAPABILITY }],
    feature: { table: {} },
  };
  const records = { all: () => [invoice], of: () => invoice };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const field = {
    id: 'f1',
    subject: 'Invoice',
    key: 'region',
    type: 'text',
    options: null,
    validation: null,
    defaultValue: null,
    active: true,
  };
  let service: CustomFieldsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomFieldsService,
        { provide: CustomFieldsRepository, useValue: repository },
        { provide: AuthorizationService, useValue: authorization },
        { provide: AuditService, useValue: audit },
        { provide: Records, useValue: records },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(CustomFieldsService);
  });

  it('names the subjects the caller may read, and 403 when none', async () => {
    authorization.can.mockResolvedValue(true);
    await expect(service.readableSubjects(user)).resolves.toEqual({
      items: [
        {
          subject: 'Invoice',
          label: { singular: 'Invoice', plural: 'Invoices' },
        },
      ],
    });
    authorization.can.mockResolvedValue(false);
    await expect(service.readableSubjects(user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('counts values only for those who manage the fields', async () => {
    repository.definitions.mockResolvedValue([field]);
    repository.valueCounts.mockResolvedValue({ r0: 3, d0: 1 });
    await expect(
      service.list(user, { subject: 'Invoice', include: 'counts' } as never),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          key: 'region',
          default: null,
          valueCount: 3,
          deletedValueCount: 1,
        }),
      ],
    });
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.anything(),
      'manageCustomFields',
      user,
    );
  });

  it(`refuses a field past ${MAX_ACTIVE_FIELDS} active ones`, async () => {
    repository.countActive.mockResolvedValue(MAX_ACTIVE_FIELDS);
    await expect(
      service.create(user, {
        subject: 'Invoice',
        key: 'more',
        label: 'More',
        type: 'text',
      } as never),
    ).rejects.toMatchObject({ response: { code: 'custom_field_limit' } });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('refuses a type change while records hold values', async () => {
    repository.findById.mockResolvedValue(field);
    repository.holdsValues.mockResolvedValue(true);
    await expect(
      service.update(user, 'f1', { type: 'number' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('allows a safe type change without asking about values', async () => {
    repository.findById.mockResolvedValue(field);
    repository.update.mockResolvedValue({ ...field, type: 'longText' });
    await service.update(user, 'f1', { type: 'longText' } as never);
    expect(repository.holdsValues).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'customField.updated' }),
    );
  });
});

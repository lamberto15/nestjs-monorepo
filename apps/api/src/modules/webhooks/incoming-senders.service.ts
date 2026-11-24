import { randomBytes } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  IncomingSendersRepository,
  type Sender,
} from './incoming-senders.repository.js';
import type { ResolvedSender } from './tenant-sender.scheme.js';
import type {
  CreateIncomingSenderDto,
  RotateIncomingSenderDto,
  UpdateIncomingSenderDto,
} from './webhooks.schemas.js';
import { incomingWebhookSenders } from './webhooks.tables.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a tenant's sender POSTs, under the API origin. */
export const senderPath = (tenantId: string, name: string) =>
  `/v1/webhooks/tenants/${tenantId}/senders/${name}`;

/** A new secret, shaped as the outgoing endpoints': `whsec_` and 32 random bytes in base64. */
const generateSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

const view = (sender: Sender, now = new Date()) => ({
  id: sender.id,
  name: sender.name,
  description: sender.description,
  enabled: sender.enabled,
  path: senderPath(sender.tenantId, sender.name),
  // Only while the old secret still verifies.
  previousSecretExpiresAt:
    sender.previousSecret &&
    sender.previousSecretExpiresAt &&
    sender.previousSecretExpiresAt > now
      ? sender.previousSecretExpiresAt.toISOString()
      : null,
  createdAt: sender.createdAt.toISOString(),
  updatedAt: sender.updatedAt.toISOString(),
});

/**
 * The senders of a tenant's incoming webhooks, managed by its users with
 * `Webhooks.manageSenders`, found by the receiver route inside the tenant
 * the URL names. Each write is one transaction with its audit entry, which
 * never carries a secret; the secrets are sealed (core/encryption).
 */
@EncryptedColumns([
  incomingWebhookSenders.secret,
  incomingWebhookSenders.previousSecret,
])
@Injectable()
export class IncomingSendersService {
  constructor(
    private readonly senders: IncomingSendersRepository,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  async list() {
    const rows = await this.senders.list();
    return { items: rows.map((row) => view(row)) };
  }

  async get(id: string) {
    return view(await this.find(id));
  }

  /** A new sender and its secret, shown this once. */
  async create(
    principal: Principal,
    dto: CreateIncomingSenderDto,
    ip?: string,
  ) {
    const secret = generateSecret();
    try {
      const row = await this.insert(principal, dto, secret, ip);
      return { ...view(row), secret };
    } catch (error) {
      if (databaseErrorKind(error) === 'unique_violation') {
        throw new ConflictException({
          code: 'conflict',
          message: `A webhook sender named "${dto.name}" exists.`,
        });
      }
      throw error;
    }
  }

  @Transactional()
  private async insert(
    principal: Principal,
    dto: CreateIncomingSenderDto,
    secret: string,
    ip?: string,
  ) {
    const created = await this.senders.insert({
      name: dto.name,
      description: dto.description ?? null,
      secret: this.encryption.encrypt(incomingWebhookSenders.secret, secret),
    });
    await this.audit.record(principal, {
      action: 'webhookSender.created',
      targetType: 'webhookSender',
      targetId: created.id,
      details: { name: dto.name },
      ip,
    });
    return created;
  }

  @Transactional()
  async update(
    principal: Principal,
    id: string,
    dto: UpdateIncomingSenderDto,
    ip?: string,
  ) {
    const before = await this.find(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateIncomingSenderDto;
    if (Object.keys(values).length === 0) return view(before);
    const updated = await this.senders.update(id, values);
    await this.audit.record(principal, {
      action: 'webhookSender.updated',
      targetType: 'webhookSender',
      targetId: id,
      details: { name: before.name, changed: Object.keys(values) },
      ip,
    });
    return view(updated);
  }

  /** A new secret, shown this once; the old one verifies for `graceSeconds` more. */
  @Transactional()
  async rotate(
    principal: Principal,
    id: string,
    dto: RotateIncomingSenderDto,
    ip?: string,
  ) {
    const before = await this.find(id);
    const secret = generateSecret();
    const graceEnds =
      dto.graceSeconds > 0
        ? new Date(Date.now() + dto.graceSeconds * 1000)
        : null;
    const updated = await this.senders.update(id, {
      secret: this.encryption.encrypt(incomingWebhookSenders.secret, secret),
      // Sealed already, under the same binding: it moves as it is.
      previousSecret: graceEnds ? before.secret : null,
      previousSecretExpiresAt: graceEnds,
    });
    await this.audit.record(principal, {
      action: 'webhookSender.secret-rotated',
      targetType: 'webhookSender',
      targetId: id,
      details: {
        name: before.name,
        previousSecretEnds: graceEnds?.toISOString() ?? null,
      },
      ip,
    });
    return { ...view(updated), secret };
  }

  @Transactional()
  async remove(principal: Principal, id: string, ip?: string) {
    const before = await this.find(id);
    await this.senders.delete(id);
    await this.audit.record(principal, {
      action: 'webhookSender.deleted',
      targetType: 'webhookSender',
      targetId: id,
      details: { name: before.name },
      ip,
    });
  }

  /**
   * The enabled sender `name` of the active tenant `tenantId`, with the
   * secrets that verify now, or null for anything else (no such tenant or
   * sender, a disabled one, a secret that doesn't open). The lookup runs in
   * that tenant's scope, so another tenant's sender is never visible under
   * this URL; the caller answers all of these alike (401).
   */
  async resolve(
    tenantId: string,
    name: string,
  ): Promise<ResolvedSender | null> {
    if (!UUID.test(tenantId)) return null;
    const tenant = await this.tenancy.find(tenantId.toLowerCase());
    if (!tenant?.active) return null;
    const row = await this.tenancy.run(tenant.id, () =>
      this.senders.findByName(name),
    );
    if (!row?.enabled) return null;
    const secrets = [
      this.open(row.secret, row.tenantId),
      row.previousSecret &&
      row.previousSecretExpiresAt &&
      row.previousSecretExpiresAt > new Date()
        ? this.open(row.previousSecret, row.tenantId)
        : undefined,
    ].filter((secret): secret is string => !!secret);
    return secrets.length > 0
      ? { id: row.id, tenantId: row.tenantId, name: row.name, secrets }
      : null;
  }

  /** The secret, or undefined when it doesn't open (a key removed, a value moved by hand). */
  private open(stored: string, tenantId: string) {
    try {
      return this.encryption.decrypt(
        incomingWebhookSenders.secret,
        stored,
        tenantId,
      );
    } catch {
      return undefined;
    }
  }

  private async find(id: string): Promise<Sender> {
    const row = await this.senders.findById(id);
    if (!row) {
      throw new NotFoundException(`Webhook sender ${id} not found.`);
    }
    return row;
  }
}

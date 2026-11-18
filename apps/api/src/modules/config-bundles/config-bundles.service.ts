import { createHash } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import {
  type ConfigBundle,
  type ConfigPreview,
  CONFIG_BUNDLE_VERSION,
} from './config-bundles.schemas.js';
import {
  BundleSections,
  type SectionPreview,
} from './config-bundles.sections.js';

type Issue = ConfigPreview['errors'][number];

/** JSON with every object's keys sorted: the same contents, the same text, the same checksum. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      // Code-unit order, not the locale's: the checksum must not depend on where it runs.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const checksumOf = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/**
 * Promoting configuration between environments (README.md): a tenant's
 * configuration, one section per module (BundleSection), exported as a
 * checksummed bundle, previewed against another tenant (a diff and the
 * validation the target's own modules make), then applied there in one
 * transaction.
 *
 * - Additive: what the target has and the bundle lacks stays.
 * - Version conflicts: the preview answers `targetVersion`, a checksum of
 *   what the target holds for what the bundle touches; apply refuses with
 *   409 `config_changed` when it moved since.
 * - A newer bundle format, a damaged checksum, a section the target does
 *   not have (a module not deployed) or an item its module refuses stops
 *   the whole bundle: nothing is applied.
 */
@Injectable()
export class ConfigBundlesService {
  constructor(
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly sections: BundleSections,
    private readonly audit: AuditService,
  ) {}

  /** This tenant's configuration as a bundle. */
  async export(): Promise<ConfigBundle> {
    const contents: Record<string, unknown> = {};
    for (const { name, handler } of this.sections.all()) {
      contents[name] = await handler.export();
    }
    return {
      format: 'config-bundle',
      version: CONFIG_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      checksum: checksumOf(contents),
      contents,
    };
  }

  /** What applying the bundle here would do, and whether it may. Changes nothing. */
  async preview(bundle: ConfigBundle): Promise<ConfigPreview> {
    return (await this.check(bundle)).preview;
  }

  /**
   * Applies a previewed bundle: section by section in their order, through
   * the modules' own writes (their checks, locks and audit entries), in one
   * transaction: one failure and nothing stays. One `config-bundle.applied`
   * audit entry sums it up.
   */
  async apply(
    actor: UserPrincipal,
    bundle: ConfigBundle,
    targetVersion: string,
    ip?: string,
  ) {
    return this.txHost.withTransaction(async () => {
      const { preview, parsed } = await this.check(bundle);
      if (preview.targetVersion !== targetVersion) {
        throw new ConflictException({
          code: 'config_changed',
          message:
            'The target changed since the preview: preview the bundle again.',
        });
      }
      if (!preview.valid) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: 'The bundle is invalid here.',
          errors: preview.errors.map((issue) => ({
            path:
              [issue.section, issue.ref].filter(Boolean).join('.') || 'bundle',
            message: issue.message,
          })),
        });
      }
      for (const { name, handler } of this.sections.all()) {
        if (!(name in parsed)) continue;
        await handler.import(actor, parsed[name], {
          changes: preview.changes
            .filter((change) => change.section === name)
            .map(({ ref, action }) => ({ ref, action })),
          ip,
        });
      }
      const count = (wanted: ConfigPreview['changes'][number]['action']) =>
        preview.changes.filter((change) => change.action === wanted).length;
      const counts = {
        created: count('create'),
        updated: count('update'),
        unchanged: count('unchanged'),
      };
      await this.audit.record(actor, {
        action: 'config-bundle.applied',
        details: {
          checksum: bundle.checksum,
          exportedAt: bundle.exportedAt,
          ...counts,
        },
        ip,
      });
      return counts;
    });
  }

  private async check(bundle: ConfigBundle) {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    const changes: ConfigPreview['changes'] = [];
    const touched: Record<string, unknown> = {};
    const parsed: Record<string, unknown> = {};
    if (bundle.version > CONFIG_BUNDLE_VERSION) {
      errors.push({
        section: null,
        ref: null,
        message: `Bundle format ${bundle.version} is newer than this deployment reads (${CONFIG_BUNDLE_VERSION}): upgrade it first.`,
      });
    }
    if (checksumOf(bundle.contents) !== bundle.checksum) {
      errors.push({
        section: null,
        ref: null,
        message:
          'The checksum does not match the contents: the bundle was changed or damaged after export.',
      });
    }
    for (const name of Object.keys(bundle.contents).sort()) {
      const handler = this.sections.find(name);
      if (!handler) {
        errors.push({
          section: name,
          ref: null,
          message:
            'No such section here: the module that owns it is not deployed.',
        });
        continue;
      }
      const shape = handler.schema.safeParse(bundle.contents[name]);
      if (!shape.success) {
        errors.push(
          ...shape.error.issues.map((issue) => ({
            section: name,
            ref: null,
            message: `${issue.path.join('.') || 'contents'}: ${issue.message}`,
          })),
        );
        continue;
      }
      parsed[name] = shape.data;
      const result: SectionPreview = await handler.preview(
        shape.data,
        bundle.contents,
      );
      errors.push(
        ...(result.errors ?? []).map((e) => ({ section: name, ...e })),
      );
      warnings.push(
        ...(result.warnings ?? []).map((w) => ({ section: name, ...w })),
      );
      changes.push(...result.changes.map((c) => ({ section: name, ...c })));
      touched[name] = result.touched;
    }
    const preview: ConfigPreview = {
      valid: errors.length === 0,
      errors,
      warnings,
      changes,
      targetVersion: checksumOf(touched),
    };
    return { preview, parsed };
  }
}

import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import {
  detectContentType,
  StorageDisk,
  StorageFileNotFoundError,
} from '@nestjs/storage';
import { DiscoveryService } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { MailBrand, type MailBrandData } from '../../core/mail/mail-brand.js';
import { httpConfig } from '../../core/http/http.config.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { discoverOne } from '../../iam/auth/discover.js';
import { DomainChangeGuard } from '../../iam/tenants/domain-change-guard.js';
import {
  HostTenantResolver,
  type HostTenants,
} from '../../iam/auth/host-tenant.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  ImageProcessor,
  ImageRejectedError,
} from '../images/image-processor.js';
import { SettingsService } from '../settings/settings.service.js';
import { tenantFileKey } from '../storage/storage.keys.js';
import { StoredFiles } from '../storage/storage.release.js';
import type {
  Branding,
  PublicBrand,
  UpdateBranding,
} from './branding.schemas.js';
import {
  BRANDING_DARK_PRIMARY_COLOR,
  BRANDING_LOCKED,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_PRIMARY_COLOR,
  DISPLAY_NAME,
  HEX_COLOR,
} from './branding.settings.js';
import { BrandingPolicy } from './branding.policy.js';
import { brandingLogos, type LogoVariant } from './branding.tables.js';

/** What a logo may be: recognized by its bytes (the first ones), never by the name or the type the client says. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** SVG is left out on purpose: it runs scripts when opened. */
export const LOGO_MAX_BYTES = 512 * 1024;

/** The accent when no tenant sets one. */
export const DEFAULT_BRAND_COLOR = '#1f2328';

/** The branding of a document: what the PDF templates show (`brand`). */
export interface DocumentBrand {
  name: string | null;
  color: string;
  /** A `data:` URL: the document's page loads nothing else. */
  logo: string | null;
}

/**
 * A stored colour or name, checked again where it is used. The settings'
 * schemas already refuse anything else, at every write; this is the second
 * wall for what reaches a style attribute or a mail header (an enforced
 * platform value, a row written by hand): anything unexpected is dropped,
 * never escaped into place.
 */
export const safeColor = (value: string | null) =>
  value !== null && HEX_COLOR.test(value) ? value : null;
export const safeName = (value: string | null) =>
  value !== null && value.length <= 60 && DISPLAY_NAME.test(value)
    ? value
    : null;

const NONE: PublicBrand = {
  primaryColor: null,
  darkPrimaryColor: null,
  mailFromName: null,
  logoUrl: null,
  darkLogoUrl: null,
};

/**
 * A tenant's branding (README.md): the colour and the mail sender's name
 * are settings (`branding.*`, tenant scope, audited by the settings
 * service), the logos files on the private disk at keys of the tenant's own
 * (`tenants/<id>/branding/…`), one per variant: a new one replaces it. The
 * operators lock all of it with `branding.locked`, which also refuses a new
 * domain or its check (iam/tenants' `@DomainChangeGuard()`).
 */
@MailBrand()
@DomainChangeGuard()
@Injectable()
export class BrandingService {
  private hosts?: HostTenants;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly disk: StorageDisk,
    private readonly files: StoredFiles,
    private readonly audit: AuditService,
    private readonly images: ImageProcessor,
    private readonly tenancy: Tenancy,
    private readonly policy: BrandingPolicy,
    private readonly discovery: DiscoveryService,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {
    // The settings API is a way in too: the lock holds there as on /v1/branding.
    for (const declaration of [
      BRANDING_PRIMARY_COLOR,
      BRANDING_DARK_PRIMARY_COLOR,
      BRANDING_MAIL_FROM_NAME,
    ]) {
      settings.guardWrite(declaration, async (write) =>
        write.scope !== 'platform' &&
        (await settings.enabled(BRANDING_LOCKED, write.actor))
          ? { code: 'branding_locked', message: t('branding.locked') }
          : undefined,
      );
    }
  }

  /** The key of a new logo file: unique, so a replaced logo never serves stale from a cache. */
  static logoKey(tenantId: string, version: string, variant: LogoVariant) {
    return tenantFileKey(
      tenantId,
      `branding/${variant === 'dark' ? 'logo-dark' : 'logo'}-${version}`,
    );
  }

  /** What the caller sees: the tenant's branding, and whether they may change it. */
  async view(principal: Principal): Promise<Branding> {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) {
      // A signed-in caller with no tenant is still routed into the web app,
      // which asks for the theme: nothing is branded, nothing is theirs to change.
      return { ...NONE, locked: false, canEdit: false };
    }
    const locked = await this.settings.enabled(BRANDING_LOCKED, principal);
    return {
      ...(await this.brand(tenantId)),
      locked,
      canEdit: !locked && (await this.policy.update(principal)),
    };
  }

  /**
   * The brand of `tenantId`, the tenant in scope: what the web app shows,
   * before sign-in too (a verified custom domain's, HostBrandingController).
   */
  async brand(tenantId: string): Promise<PublicBrand> {
    const [primaryColor, darkColor, mailFromName, logos] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_DARK_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.db.select({ variant: brandingLogos.variant }).from(brandingLogos),
    ]);
    const has = (variant: LogoVariant) =>
      logos.some((logo) => logo.variant === variant);
    return {
      primaryColor: safeColor(primaryColor),
      darkPrimaryColor: safeColor(darkColor),
      mailFromName: safeName(mailFromName),
      logoUrl: has('light') ? logoPath(tenantId, 'light') : null,
      darkLogoUrl: has('dark') ? logoPath(tenantId, 'dark') : null,
    };
  }

  /**
   * A 409 `branding_locked` while the operators have it locked. Asked for
   * the writer: the operators' platform rules (by tenant slug) match a
   * principal, never the nobody of a job.
   */
  async assertEditable(actor: Principal) {
    if (await this.settings.enabled(BRANDING_LOCKED, actor)) {
      throw new ConflictException({
        code: 'branding_locked',
        message: t('branding.locked'),
      });
    }
  }

  /**
   * Sets or removes the colour and the sender name (`null` removes, an
   * absent key stays), through the settings service: the same schemas, the
   * same audit entries (`setting.updated`, `setting.reset`).
   */
  async update(
    actor: Principal,
    changes: UpdateBranding,
    ip?: string,
  ): Promise<Branding> {
    await this.assertEditable(actor);
    for (const [declaration, value] of [
      [BRANDING_PRIMARY_COLOR, changes.primaryColor],
      [BRANDING_DARK_PRIMARY_COLOR, changes.darkPrimaryColor],
      [BRANDING_MAIL_FROM_NAME, changes.mailFromName],
    ] as const) {
      if (value === undefined) continue;
      if (value === null) {
        await this.settings.unset(
          actor,
          declaration.key,
          'tenant',
          undefined,
          ip,
        );
      } else {
        await this.settings.set(
          actor,
          declaration.key,
          { scope: 'tenant', value },
          ip,
        );
      }
    }
    return this.view(actor);
  }

  /**
   * The upload is already on the disk (BrandingLogoUpload, which checked the
   * lock and recognized the bytes). The image processor has the last word
   * (a damaged file is refused, metadata is stripped); the tenant's row
   * then names the new file and the old one goes. Audited. The image is
   * processed before the transaction: it takes seconds on a large one, and
   * would hold a database connection all that time.
   */
  async logoUploaded(
    actor: Principal,
    file: { contentType: string; key: string },
    variant: LogoVariant,
    ip?: string,
  ): Promise<Branding> {
    let bytes = await this.disk.getBuffer(file.key);
    try {
      // Stripped only: a logo is shown as it is, never by a rendition.
      const stripped = await this.images.strip(bytes);
      if (stripped) {
        bytes = stripped.data;
        await this.disk.put(file.key, bytes, { contentType: file.contentType });
      }
    } catch (error) {
      await this.disk.delete(file.key);
      if (error instanceof ImageRejectedError) {
        throw new UnsupportedMediaTypeException(t('branding.badImage'));
      }
      throw error;
    }
    try {
      return await this.saveLogo(actor, file, variant, bytes.length, ip);
    } catch (error) {
      // Rolled back: the row still names the old file, the new one is no one's.
      await this.disk.delete(file.key).catch(() => undefined);
      throw error;
    }
  }

  @Transactional()
  private async saveLogo(
    actor: Principal,
    file: { contentType: string; key: string },
    variant: LogoVariant,
    size: number,
    ip?: string,
  ): Promise<Branding> {
    const tenantId = this.tenancy.tenantId();
    const [old] = await this.db
      .select({ key: brandingLogos.key })
      .from(brandingLogos)
      .where(eq(brandingLogos.variant, variant));
    const values = { key: file.key, contentType: file.contentType, size };
    await this.db
      .insert(brandingLogos)
      .values({ variant, ...values })
      .onConflictDoUpdate({
        target: [brandingLogos.tenantId, brandingLogos.variant],
        set: { ...values, updatedAt: new Date() },
      });
    await this.audit.record(actor, {
      action: 'branding.logo-changed',
      targetType: 'tenant',
      targetId: tenantId,
      details: { contentType: file.contentType, size, variant },
      ip,
    });
    // After the commit: a rollback leaves the old row naming its file.
    if (old) await this.files.release([old.key]);
    return this.view(actor);
  }

  @Transactional()
  async removeLogo(
    actor: Principal,
    variant: LogoVariant,
    ip?: string,
  ): Promise<void> {
    await this.assertEditable(actor);
    const [logo] = await this.db
      .delete(brandingLogos)
      .where(eq(brandingLogos.variant, variant))
      .returning({ key: brandingLogos.key });
    if (!logo) {
      throw new NotFoundException(t('branding.noLogo'));
    }
    await this.audit.record(actor, {
      action: 'branding.logo-removed',
      targetType: 'tenant',
      targetId: this.tenancy.tenantId(),
      details: { variant },
      ip,
    });
    await this.files.release([logo.key]);
  }

  /**
   * The logo of an active tenant, for the public route (a logo is not a
   * secret: mail and the sign-in page show it), or null. An id that is not
   * an active tenant's gets nothing, and the type is the one stored at
   * upload, from the allowlist.
   */
  async logoFile(requestedId: string, variant: LogoVariant) {
    const tenant = await this.tenancy.find(requestedId);
    if (!tenant?.active) return null;
    const logo = await this.tenancy.run(tenant.id, async () => {
      const [row] = await this.db
        .select()
        .from(brandingLogos)
        .where(eq(brandingLogos.variant, variant));
      return row;
    });
    if (!logo) return null;
    try {
      const file = await this.disk.get(logo.key);
      return {
        contentType: logo.contentType,
        size: file.size,
        body: file.body,
      };
    } catch (error) {
      if (error instanceof StorageFileNotFoundError) return null;
      throw error;
    }
  }

  /** The current tenant's brand for mail, or null outside a tenant. */
  async current(): Promise<MailBrandData | null> {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return null;
    const [color, name, logo] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.hasLogo('light'),
    ]);
    return {
      name: safeName(name),
      color: safeColor(color) ?? DEFAULT_BRAND_COLOR,
      logoUrl: logo
        ? `${this.http.appUrl}${logoPath(tenantId, 'light')}`
        : null,
    };
  }

  /** The current tenant's brand for a PDF: the logo inline, as a `data:` URL. */
  async forDocument(): Promise<DocumentBrand> {
    const tenantId = currentTenantScope()?.tenantId;
    const none = { name: null, color: DEFAULT_BRAND_COLOR, logo: null };
    if (!tenantId) return none;
    const [color, name, [logo]] = await Promise.all([
      this.settings.get(BRANDING_PRIMARY_COLOR),
      this.settings.get(BRANDING_MAIL_FROM_NAME),
      this.db
        .select({ key: brandingLogos.key })
        .from(brandingLogos)
        .where(eq(brandingLogos.variant, 'light')),
    ]);
    let data: string | null = null;
    if (logo) {
      try {
        const bytes = await this.disk.getBuffer(logo.key);
        // The type the bytes say, from the allowlist, never the stored metadata.
        const type = detectContentType(bytes);
        if (type && (LOGO_TYPES as readonly string[]).includes(type)) {
          data = `data:${type};base64,${bytes.toString('base64')}`;
        }
      } catch (error) {
        // A file gone from the disk: a document without the logo, not a failed job.
        if (!(error instanceof StorageFileNotFoundError)) throw error;
      }
    }
    return {
      name: safeName(name),
      color: safeColor(color) ?? none.color,
      logo: data,
    };
  }

  /**
   * The brand of the tenant whose verified custom domain `hostname` is (the
   * iam/tenants module keeps the domains: its `@HostTenantResolver()`);
   * every field null for any other host, never a tenant's name.
   */
  async brandOfHost(hostname: string | undefined): Promise<PublicBrand> {
    this.hosts ??= discoverOne<HostTenants>(
      this.discovery,
      HostTenantResolver,
      'host-to-tenant resolver (@HostTenantResolver())',
    );
    const tenantId = hostname ? await this.hosts?.tenantOfHost(hostname) : null;
    if (!tenantId) return NONE;
    return this.tenancy.run(tenantId, () => this.brand(tenantId));
  }

  private async hasLogo(variant: LogoVariant) {
    const [row] = await this.db
      .select({ variant: brandingLogos.variant })
      .from(brandingLogos)
      .where(eq(brandingLogos.variant, variant));
    return !!row;
  }
}

const logoPath = (tenantId: string, variant: LogoVariant) =>
  `/v1/branding/${tenantId}/logo${variant === 'dark' ? '/dark' : ''}`;

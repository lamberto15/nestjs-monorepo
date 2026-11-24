import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { brandingLogos, type LogoVariant } from './branding.tables.js';

/** The tenant's logo rows, in the caller's transaction and tenant. */
@Injectable()
export class BrandingRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The variants the tenant has a logo of. */
  async variants() {
    const rows = await this.db
      .select({ variant: brandingLogos.variant })
      .from(brandingLogos);
    return rows.map((row) => row.variant);
  }

  async findLogo(variant: LogoVariant) {
    const [row] = await this.db
      .select()
      .from(brandingLogos)
      .where(eq(brandingLogos.variant, variant));
    return row;
  }

  /** Inserts the variant's logo, or replaces the one there. */
  async saveLogo(
    variant: LogoVariant,
    values: { key: string; contentType: string; size: number },
  ) {
    await this.db
      .insert(brandingLogos)
      .values({ variant, ...values })
      .onConflictDoUpdate({
        target: [brandingLogos.tenantId, brandingLogos.variant],
        set: { ...values, updatedAt: new Date() },
      });
  }

  /** Deletes the variant's logo, and returns its file's key. */
  async deleteLogo(variant: LogoVariant) {
    const [row] = await this.db
      .delete(brandingLogos)
      .where(eq(brandingLogos.variant, variant))
      .returning({ key: brandingLogos.key });
    return row;
  }
}

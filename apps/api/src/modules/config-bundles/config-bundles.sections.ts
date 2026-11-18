import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { z } from 'zod';
import type { UserPrincipal } from '../../iam/auth/principal.js';

/** What a section's dry run found in the target: what applying would do, and what stops it. */
export interface SectionPreview {
  /** One per item of the bundle: its stable reference (a key, a name) and what applying does to it. */
  changes: { ref: string; action: 'create' | 'update' | 'unchanged' }[];
  errors?: { ref: string | null; message: string }[];
  /** Applied as they are, but worth a look. */
  warnings?: { ref: string | null; message: string }[];
  /** What the target holds for what the bundle touches: apply refuses when it moved since the preview. */
  touched: unknown;
}

/**
 * The configuration one module carries in a bundle. Items are told apart by
 * stable references (a setting's key, a role's name), never by this
 * environment's ids; nothing secret and no business record is in one.
 */
export interface BundleSectionHandler<T = unknown> {
  /** The section's contents as the bundle holds them: what the module's own services return for the tenant. */
  schema: z.ZodType<T>;
  /** The current tenant's configuration, in a stable order. */
  export(): Promise<T>;
  /**
   * A dry run against the current tenant. `bundle` is every section of the
   * bundle as it came (unchecked), for a section that refers to another's
   * items (a flag rule naming a role the bundle brings).
   */
  preview(
    contents: T,
    bundle: Readonly<Record<string, unknown>>,
  ): Promise<SectionPreview>;
  /**
   * Applies the contents in the apply's transaction, through the module's
   * own services (their checks, locks and audit entries). `changes` is
   * what `preview()` said: leave the unchanged alone.
   */
  import(
    actor: UserPrincipal,
    contents: T,
    context: { changes: SectionPreview['changes']; ip?: string },
  ): Promise<void>;
}

const Marker = DiscoveryService.createDecorator<{
  name: string;
  order: number;
}>();

/**
 * Marks a provider as a section of the configuration bundle, named in
 * lower case words (`settings`, `roles`). Sections are applied by
 * ascending `order` (default 0): one that refers to another's items comes
 * after it.
 *
 * ```ts
 * @BundleSection('templates')
 * @Injectable()
 * export class TemplatesBundle implements BundleSectionHandler<Template[]> { … }
 * ```
 */
export const BundleSection = (name: string, options: { order?: number } = {}) =>
  Marker({ name, order: options.order ?? 0 });

/** The sections of the app, found by discovery when it starts. */
@Injectable()
export class BundleSections implements OnModuleInit {
  private readonly sections = new Map<
    string,
    { order: number; handler: BundleSectionHandler }
  >();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: Marker.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(Marker, wrapper);
      if (!meta || !wrapper.instance) continue;
      if (this.sections.has(meta.name) || !/^[a-z][a-z-]*$/.test(meta.name)) {
        throw new Error(
          `Two bundle sections are named "${meta.name}", or the name is not lower case words.`,
        );
      }
      this.sections.set(meta.name, {
        order: meta.order,
        handler: wrapper.instance as BundleSectionHandler,
      });
    }
  }

  find(name: string) {
    return this.sections.get(name)?.handler;
  }

  /** Every section, in the order they are applied. */
  all() {
    return [...this.sections]
      .sort(([a, x], [b, y]) => x.order - y.order || a.localeCompare(b))
      .map(([name, { handler }]) => ({ name, handler }));
  }
}

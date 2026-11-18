import {
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import type { FormDefinition, FormFieldType } from './form-definition.js';
import { secretColumns } from '../../core/database/secret-columns.js';

/** `active`: takes submissions once published; `archived`: takes none, its submissions stay. */
export const FORM_STATUSES = ['active', 'archived'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/**
 * A tenant's runtime forms: the definition being edited (`draft`, saved
 * with the `revision` it was edited from) and the number of the version
 * submitters fill in now (`published_version`). Publishing copies the
 * draft into `form_versions`, never edited again.
 */
export const forms = tenantTable(
  'forms',
  {
    id: uuidPk(),
    /** Unique in the tenant: `incident-report`. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<FormStatus>().notNull().default('active'),
    draft: jsonb('draft').$type<FormDefinition>().notNull(),
    /** Raised by every saved draft: what a draft save or a publication names to be conflict-safe. */
    revision: integer('revision').notNull().default(1),
    /** The version submitters fill in; null until the first publication. */
    publishedVersion: integer('published_version'),
    /** The draft revision that version was published from: the draft has changes while it differs. */
    publishedRevision: integer('published_revision'),
    /** Every key any published version had, with its type: a key's type never changes. */
    keyTypes: jsonb('key_types')
      .$type<Record<string, FormFieldType>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (t) => [uniqueIndex('forms_slug_idx').on(t.tenantId, t.slug)],
  { referenced: true },
);

export type FormRow = typeof forms.$inferSelect;

/** Published versions: immutable snapshots, 1, 2, 3… per form. */
export const formVersions = tenantTable(
  'form_versions',
  {
    id: uuidPk(),
    formId: uuid('form_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<FormDefinition>().notNull(),
    publishedAt: at('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_versions_form_version_idx').on(
      t.tenantId,
      t.formId,
      t.version,
    ),
    // Cascade, so a tenant's deletion goes through; the service deletes
    // only forms never published (409 form_published): none has versions.
    tenantReference(
      'form_versions_form_fk',
      [t.tenantId, t.formId],
      [forms.tenantId, forms.id],
    ),
  ],
  { referenced: true },
);

export type FormVersionRow = typeof formVersions.$inferSelect;

/**
 * Answers to a published version, as the server validated them. The
 * version is the one they were checked against, for good: a later version
 * never reinterprets them.
 */
export const formSubmissions = tenantTable(
  'form_submissions',
  {
    id: uuidPk(),
    formId: uuid('form_id').notNull(),
    versionId: uuid('version_id').notNull(),
    /** Who submitted: `user:<id>`, `client:<id>`, or `public:<link id>`. */
    submittedBy: text('submitted_by').notNull(),
    /** `submitted`, the only one yet (a review status may follow). */
    status: text('status').$type<'submitted'>().notNull().default('submitted'),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    ...timestamps(),
  },
  (t) => [
    index('form_submissions_form_idx').on(t.tenantId, t.formId, t.id),
    index('form_submissions_submitted_by_idx').on(
      t.tenantId,
      t.submittedBy,
      t.formId,
    ),
    index('form_submissions_version_idx').on(t.tenantId, t.versionId),
    tenantReference(
      'form_submissions_form_fk',
      [t.tenantId, t.formId],
      [forms.tenantId, forms.id],
    ),
    tenantReference(
      'form_submissions_version_fk',
      [t.tenantId, t.versionId],
      [formVersions.tenantId, formVersions.id],
    ),
  ],
);

export type FormSubmissionRow = typeof formSubmissions.$inferSelect;

/**
 * A form's public links (README.md, "Public forms"): an editor makes one
 * explicitly; anyone holding it fills in the published version without an
 * account, until it expires, is revoked or has taken `maxSubmissions`.
 * Only the token's hash is kept (the link is shown once). The token names
 * its tenant, so it is looked up in that tenant's scope.
 */
export const formPublicLinks = tenantTable(
  'form_public_links',
  {
    id: uuidPk(),
    formId: uuid('form_id').notNull(),
    /** The SHA-256 of the link's token, base64url. */
    tokenHash: text('token_hash').notNull(),
    /** `user:<id>` of the editor who made it. */
    createdBy: text('created_by').notNull(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
    revokedBy: text('revoked_by'),
    /** The most submissions it takes (its quota), and how many it took. */
    maxSubmissions: integer('max_submissions').notNull(),
    submissions: integer('submissions').notNull().default(0),
    lastSubmittedAt: at('last_submitted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('form_public_links_token_idx').on(t.tenantId, t.tokenHash),
    index('form_public_links_form_idx').on(t.tenantId, t.formId),
    tenantReference(
      'form_public_links_form_fk',
      [t.tenantId, t.formId],
      [forms.tenantId, forms.id],
    ),
  ],
);

export type FormPublicLinkRow = typeof formPublicLinks.$inferSelect;

secretColumns(formPublicLinks, [formPublicLinks.tokenHash]);

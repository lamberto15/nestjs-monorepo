import type { ReactNode } from 'react';

/**
 * A feature's own form and delete, for a parent's page to add, change and
 * delete its records in place (RelatedPanel: the lines of an invoice). Each
 * feature with a form registers its subject in
 * `features/<feature>/record-form.tsx` (default export), as it registers
 * its page in `record-link.ts`; removing the feature removes it. A subject
 * without one is listed, not edited, in its parents' panels.
 */
export type RecordForm = {
  subject: string;
  /**
   * The form in place: a create with `parent` (that reference filled in,
   * its input hidden), or an edit of `id`. `onDone` closes it: after a
   * save (with the record) or a cancel (without).
   */
  Form: (props: {
    id?: string;
    parent?: { field: string; id: string };
    onDone: (saved?: { id: string }) => void;
  }) => ReactNode;
  /** The feature's delete: `ask(record)` opens its confirmation, `dialog` renders it. */
  useDelete: (options?: { onDeleted?: (record: { id: string }) => void }) => {
    ask: (record: { id: string }) => void;
    dialog: ReactNode;
  };
};

const FORMS = Object.values(
  import.meta.glob<RecordForm>('../../features/*/record-form.tsx', {
    eager: true,
    import: 'default',
  }),
);

export const recordFormOf = (subject: string): RecordForm | undefined =>
  FORMS.find((form) => form.subject === subject);

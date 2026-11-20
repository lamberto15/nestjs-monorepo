import { Button } from '@nestjs-monorepo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo/ui/components/dialog';
import { Skeleton } from '@nestjs-monorepo/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PersonName, RecordName, UnitName } from '@/components/person-name';
import { recordLinkOf } from '@/features/watching/record-links';
import { useMe } from '@/lib/features';
import { customValue, fieldLabel } from '@/lib/list-columns';
import { type ListDescription, useListDescription } from '@/lib/list-query';
import { isRecordRef } from '@/lib/list-refs';
import { useRecordCan } from '@/lib/records';
import { type RecordForm, recordFormOf } from '../record-forms';
import { recordName } from '../record-picker';
import { listRelated, panelKeys, RELATED_LIMIT } from './api';

type Related = ListDescription['related'][number];
type Row = Record<string, unknown>;

/** What every record has, which a child table does not repeat. */
const COMMON = new Set([
  'id',
  'ownerId',
  'unitId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  'custom',
]);

/**
 * The records that refer to this one through one relation (a `ref` field of
 * theirs: docs/adding-a-feature.md, "Relationships"), as a table: the newest
 * RELATED_LIMIT, read from their own list filtered by the reference, so the
 * API shows only those the user may read. A title opens the record's page
 * when its feature registers one (`record-link.ts`). When the feature
 * registers its form (`record-form.tsx`), the table is where they are
 * added, changed and deleted, in place (the lines of an invoice): each
 * through the record's own routes and permissions.
 */
export function RelatedPanel(props: {
  base: string;
  id: string;
  related: Related;
}) {
  const { t } = useTranslation('records');
  const { path, field, title, subject } = props.related;
  const queryClient = useQueryClient();
  const page = useQuery({
    queryKey: panelKeys.related(props.base, props.id, path, field),
    queryFn: () => listRelated(path, field, props.id),
  });
  const description = useListDescription(subject);
  const form = recordFormOf(subject);
  const link = recordLinkOf(subject);
  const heading = `related-${path}-${field}`;
  const columns = childColumns(description.data, field, title);
  const canCreate = useMe()?.can?.[`${subject}.create`] === true;
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: panelKeys.related(props.base, props.id, path, field),
    });

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={heading} className="text-sm font-medium">
          {t('related.heading', { subject, field })}
        </h3>
        {form && canCreate && (
          <Button size="sm" variant="outline" onClick={() => setEditing({})}>
            <PlusIcon aria-hidden />
            {t('related.add')}
          </Button>
        )}
      </div>
      {page.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy />
      ) : page.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('related.error')}
        </p>
      ) : page.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('related.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table aria-labelledby={heading}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('related.name')}</TableHead>
                  {columns.map((column) => (
                    <TableHead key={column.name}>{column.label}</TableHead>
                  ))}
                  {form && (
                    <TableHead>
                      <span className="sr-only">{t('related.actions')}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.data.items.map((item) => {
                  const id = item.id as string;
                  const name = recordName(item, title);
                  return (
                    <TableRow key={id}>
                      <TableCell>
                        {link ? (
                          <Link to={link.path(id)} className="hover:underline">
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                      </TableCell>
                      {columns.map((column) => (
                        <TableCell
                          key={column.name}
                          className="max-w-48 truncate"
                        >
                          <Value column={column} value={item[column.name]} />
                        </TableCell>
                      ))}
                      {form && (
                        <TableCell className="w-0 whitespace-nowrap">
                          <RowActions
                            form={form}
                            subject={subject}
                            item={item}
                            name={name}
                            onEdit={() => setEditing({ id })}
                            onDeleted={refresh}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {(page.data.total ?? 0) > RELATED_LIMIT && (
            <p className="text-sm text-muted-foreground">
              {t('related.more', {
                shown: page.data.items.length,
                total: page.data.total ?? 0,
              })}
            </p>
          )}
        </>
      )}
      {form && (
        <Dialog
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editing?.id ? t('related.edit') : t('related.add')}
              </DialogTitle>
            </DialogHeader>
            {editing && (
              <form.Form
                id={editing.id}
                parent={editing.id ? undefined : { field, id: props.id }}
                onDone={(saved) => {
                  setEditing(null);
                  if (saved) void refresh();
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

/** A row's change and delete, when the user may (the row's `can`, else the role's). */
function RowActions(props: {
  form: RecordForm;
  subject: string;
  item: Row;
  name: string;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation('records');
  const can = useRecordCan(props.subject)(
    props.item as { can?: Record<string, boolean> },
  );
  const { useDelete } = props.form;
  const remove = useDelete({ onDeleted: props.onDeleted });
  return (
    <div className="flex justify-end gap-1">
      {can.update && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('related.editOne', { name: props.name })}
          onClick={props.onEdit}
        >
          <PencilIcon aria-hidden />
        </Button>
      )}
      {can.delete && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('related.deleteOne', { name: props.name })}
          onClick={() => remove.ask({ id: props.item.id as string })}
        >
          <Trash2Icon aria-hidden />
        </Button>
      )}
      {remove.dialog}
    </div>
  );
}

type Column = {
  name: string;
  label: string;
  type: ListDescription['fields'][number]['type'];
  ref?: string;
};

/**
 * The child's own fields a table shows: those its list may answer
 * (`select`), every one, not the reference to this parent, the title (the
 * first column), nor what every record has. A wide table scrolls sideways;
 * a long text is cut to its cell.
 */
function childColumns(
  description: ListDescription | undefined,
  parentField: string,
  title: string | null,
): Column[] {
  if (!description) return [];
  // A description without them (an older API, a test's) gives the titles only.
  const byName = new Map((description.fields ?? []).map((f) => [f.name, f]));
  return (description.select ?? [])
    .filter(
      (name) =>
        name !== parentField &&
        name !== title &&
        !COMMON.has(name) &&
        !name.startsWith('custom.'),
    )
    .flatMap((name): Column[] => {
      // A money field is listed by its currency: `amountCurrency`.
      const f = byName.get(name) ?? byName.get(`${name}Currency`);
      if (!f) return [];
      return [
        {
          name,
          label: f.label ?? fieldLabel(name),
          type: f.type,
          ...(f.ref && { ref: f.ref }),
        },
      ];
    });
}

/** A cell: a reference by name, an amount with its currency, else as a list shows it. */
function Value({ column, value }: { column: Column; value: unknown }) {
  const { t, i18n } = useTranslation('records');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && column.ref) {
    if (column.ref === 'principal') return <PersonName value={value} />;
    if (column.ref === 'unit') return <UnitName value={value} />;
    if (isRecordRef(column.ref)) {
      return <RecordName subject={column.ref} value={value} />;
    }
  }
  if (typeof value === 'object' && 'amount' in value && 'currency' in value) {
    const money = value as { amount: string; currency: string };
    return <>{`${money.amount} ${money.currency}`}</>;
  }
  return <>{customValue(value, column.type, i18n.language, t)}</>;
}

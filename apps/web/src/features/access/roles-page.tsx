import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@nestjs-monorepo/ui/components/badge';
import { buttonVariants } from '@nestjs-monorepo/ui/components/button';
import { Checkbox } from '@nestjs-monorepo/ui/components/checkbox';
import { Field, FieldLabel } from '@nestjs-monorepo/ui/components/field';
import { Input } from '@nestjs-monorepo/ui/components/input';
import { Spinner } from '@nestjs-monorepo/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo/ui/components/table';
import type { TFunction } from 'i18next';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ContrastIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { Page, PageHeader } from '@/components/page-header';
import {
  catalogQuery,
  deleteRole,
  invalidateAccess,
  rolesQuery,
  type Role,
} from '@/features/access/api';
import {
  actionKey,
  fromPermissions,
  type Catalog,
  type CatalogAction,
  type CatalogSubject,
  type EditorState,
} from '@/features/access/permissions';
import { recordsText } from '@/features/access/role-summary';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';

/** A role as the grid reads it: everything (`all.manage`), or its rules. */
interface Column {
  role: Role;
  everything: boolean;
  state: EditorState;
}

/** One cell: granted on every record, on some (which, in words), or not. */
interface Cell {
  kind: 'every' | 'some' | 'none';
  note?: string;
}

function cellOf(
  t: TFunction<'access'>,
  column: Column,
  subject: CatalogSubject,
  action: CatalogAction,
): Cell {
  if (column.everything) return { kind: 'every' };
  const rules = column.state[actionKey(subject.subject, action.action)];
  if (!rules) return { kind: 'none' };
  const note = recordsText(t, action, rules);
  return note ? { kind: 'some', note } : { kind: 'every' };
}

const differs = (cells: Cell[]) =>
  new Set(cells.map((cell) => `${cell.kind}|${cell.note ?? ''}`)).size > 1;

/**
 * The tenant's roles side by side: a row per permission (grouped by
 * subject), a column per role. Read-only: a cell opens that role's editor
 * on its subject, where it is changed.
 */
export function RolesPage() {
  const { t, i18n } = useTranslation('access');
  const roles = useQuery(rolesQuery);
  const catalog = useQuery({
    ...catalogQuery(i18n.language),
    placeholderData: keepPreviousData,
  });
  const failed = roles.error ?? catalog.error;
  return (
    <Page>
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          // A link that looks like a button: it goes to a page.
          <Link to="/access/roles/new" className={buttonVariants()}>
            <PlusIcon />
            {t('roles.new')}
          </Link>
        }
      />
      {failed ? (
        <FormAlert message={errorMessage(failed)} />
      ) : roles.data && catalog.data ? (
        <RolesGrid catalog={catalog.data} roles={roles.data} />
      ) : (
        <Spinner />
      )}
    </Page>
  );
}

function RolesGrid(props: { catalog: Catalog; roles: Role[] }) {
  const { t } = useTranslation('access');
  const filterId = useId();
  const [query, setQuery] = useState('');
  const [differOnly, setDifferOnly] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();
  const columns: Column[] = props.roles.map((role) => ({
    role,
    everything: role.permissions.some(
      (p) => p.subject === 'all' && p.action === 'manage',
    ),
    state: fromPermissions(props.catalog, role.permissions).state,
  }));
  const groups = props.catalog.subjects.map((subject) => {
    const rows = subject.actions.map((action) => {
      const cells = columns.map((column) => cellOf(t, column, subject, action));
      return { action, cells, differs: differs(cells) };
    });
    const shown = rows.filter(
      (row) =>
        (!differOnly || row.differs) &&
        (needle === '' ||
          [
            subject.label,
            subject.subject,
            row.action.label,
            actionKey(subject.subject, row.action.action),
          ].some((text) => text.toLowerCase().includes(needle))),
    );
    return { subject, rows: shown, differs: rows.some((row) => row.differs) };
  });
  const visible = groups.filter((group) => group.rows.length > 0);
  const legend = [
    { kind: 'every', label: t('roles.grid.every') },
    { kind: 'some', label: t('roles.grid.some') },
    { kind: 'none', label: t('roles.grid.none') },
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field className="w-full sm:w-72">
          <FieldLabel htmlFor={filterId} className="sr-only">
            {t('roles.grid.filter')}
          </FieldLabel>
          <Input
            id={filterId}
            type="search"
            placeholder={t('roles.grid.filter')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <Checkbox
            id={`${filterId}-differ`}
            checked={differOnly}
            onCheckedChange={(checked) => setDifferOnly(checked)}
          />
          <FieldLabel htmlFor={`${filterId}-differ`} className="font-normal">
            {t('roles.grid.differ')}
          </FieldLabel>
        </Field>
        <ul
          aria-label={t('roles.grid.legend')}
          className="flex flex-wrap gap-4 text-sm text-muted-foreground sm:ms-auto"
        >
          {legend.map((item) => (
            <li key={item.kind} className="flex items-center gap-1.5">
              <CellIcon kind={item.kind} />
              {item.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                scope="col"
                // One width for the column: long labels wrap instead of widening it.
                className="sticky start-0 z-10 w-72 min-w-56 max-w-72 bg-background"
              >
                {t('roles.grid.permission')}
              </TableHead>
              {columns.map((column) => (
                <RoleHead key={column.role.id} role={column.role} />
              ))}
            </TableRow>
          </TableHeader>
          {visible.length === 0 && (
            <TableBody>
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="text-muted-foreground"
                >
                  {t('roles.grid.noMatch')}
                </TableCell>
              </TableRow>
            </TableBody>
          )}
          {visible.map(({ subject, rows, differs: groupDiffers }) => {
            // Collapsed unless its roles differ, or a filter is looking.
            const open =
              expanded[subject.subject] ?? (groupDiffers || needle !== '');
            return (
              <TableBody key={subject.subject}>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead
                    scope="rowgroup"
                    colSpan={columns.length + 1}
                    className="p-0"
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded({ ...expanded, [subject.subject]: !open })
                      }
                      className="sticky start-0 flex items-center gap-2 px-2 py-2 text-start font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {open ? (
                        <ChevronDownIcon aria-hidden className="size-4" />
                      ) : (
                        <ChevronRightIcon aria-hidden className="size-4" />
                      )}
                      {subject.label}
                      <span className="text-xs font-normal text-muted-foreground">
                        {t('roles.grid.groupMeta', {
                          count: subject.actions.length,
                        })}
                        {groupDiffers && ` · ${t('roles.grid.groupDiffers')}`}
                      </span>
                    </button>
                  </TableHead>
                </TableRow>
                {open &&
                  rows.map(({ action, cells }) => (
                    <TableRow key={action.action}>
                      <TableHead
                        scope="row"
                        className="sticky start-0 z-10 h-auto w-72 min-w-56 max-w-72 bg-background py-2 font-normal whitespace-normal"
                      >
                        <span className="flex flex-col gap-0.5 text-pretty">
                          {action.label}
                          <code className="text-xs text-muted-foreground">
                            {actionKey(subject.subject, action.action)}
                          </code>
                        </span>
                      </TableHead>
                      {cells.map((cell, index) => (
                        <TableCell key={columns[index]!.role.id}>
                          <GridCell
                            cell={cell}
                            role={columns[index]!.role}
                            subject={subject}
                            action={action}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
              </TableBody>
            );
          })}
        </Table>
      </div>
    </div>
  );
}

function CellIcon(props: { kind: Cell['kind'] }) {
  const Icon =
    props.kind === 'every'
      ? CheckIcon
      : props.kind === 'some'
        ? ContrastIcon
        : MinusIcon;
  return (
    <Icon
      aria-hidden
      className={
        props.kind === 'none'
          ? 'size-4 shrink-0 text-muted-foreground'
          : 'size-4 shrink-0'
      }
    />
  );
}

/** A cell: what the role grants of the action, opening its editor there. */
function GridCell(props: {
  cell: Cell;
  role: Role;
  subject: CatalogSubject;
  action: CatalogAction;
}) {
  const { t } = useTranslation('access');
  const { cell } = props;
  const label =
    cell.kind === 'some'
      ? t('roles.grid.cellSome', {
          role: props.role.name,
          action: props.action.label,
          note: cell.note,
        })
      : t('roles.grid.cell', {
          role: props.role.name,
          action: props.action.label,
          state: t(`roles.grid.${cell.kind}`),
        });
  return (
    <Link
      to="/access/roles/$roleId"
      params={{ roleId: props.role.id }}
      search={{ subject: props.subject.subject }}
      aria-label={label}
      title={label}
      className="inline-flex max-w-48 items-center gap-1.5 rounded-md px-1.5 py-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <CellIcon kind={cell.kind} />
      {cell.note && (
        <span className="truncate text-xs text-muted-foreground">
          {cell.note}
        </span>
      )}
    </Link>
  );
}

/** A role's column: its name (to its editor), members, and deleting it. */
function RoleHead({ role }: { role: Role }) {
  const { t } = useTranslation('access');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteRole(role.id),
    onSuccess: async () => {
      toast.success(t('roles.deleted', { name: role.name }));
      await invalidateAccess(queryClient);
    },
  });
  return (
    <TableHead scope="col" className="h-auto min-w-36 py-2 align-top">
      <div className="flex items-start justify-between gap-1">
        <div className="flex flex-col gap-1">
          <Link
            to="/access/roles/$roleId"
            params={{ roleId: role.id }}
            className="font-medium hover:underline"
          >
            {role.name}
          </Link>
          <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground">
            {role.system && (
              <Badge variant="secondary">{t('roles.builtInBadge')}</Badge>
            )}
            {t('roles.memberCount', { count: role.members })}
          </span>
        </div>
        {!role.system && (
          <ConfirmButton
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-10"
            label={t('roles.deleteRole', { name: role.name })}
            title={t('roles.deleteTitle', { name: role.name })}
            description={t('roles.deleteDescription', {
              count: role.members,
            })}
            confirm={t('roles.delete')}
            onConfirm={() => remove.mutateAsync()}
          >
            <Trash2Icon />
          </ConfirmButton>
        )}
      </div>
    </TableHead>
  );
}

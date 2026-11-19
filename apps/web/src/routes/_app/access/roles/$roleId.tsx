import { isApiError } from '@nestjs-monorepo/api-client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Spinner } from '@nestjs-monorepo/ui/components/spinner';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { roleQuery } from '@/features/access/api';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { z } from '@/lib/zod';

export const Route = createFileRoute('/_app/access/roles/$roleId')({
  // The subject the editor opens on (a cell of the roles' grid).
  validateSearch: z.object({
    subject: z.string().max(100).optional().catch(undefined),
  }),
  beforeLoad: requirePermission('Access.manageRoles'),
  component: EditRole,
});

/** One role, read on its own (`GET /v1/access/roles/{id}`). */
function EditRole() {
  const { t } = useTranslation('access');
  const { roleId } = Route.useParams();
  const { subject } = Route.useSearch();
  // A 404 is this page's to say, not a toast's. The form is made from one
  // read and saved with its ETag (as the note and policy editors): a refetch
  // in the background would rebuild it and drop the user's edits; another
  // administrator's save makes this one a 412, whose notice offers the reload.
  const role = useQuery({
    ...roleQuery(roleId),
    meta: { errorToast: false },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const missing = isApiError(role.error) && role.error.status === 404;
  const title = role.data ? role.data.role.name : t('roles.editTitle');
  return (
    <Page>
      {role.isSuccess ? (
        // Read again (after a save or a 412's reload): a fresh form.
        <RoleForm
          key={role.data.etag ?? role.data.role.updatedAt}
          title={title}
          role={role.data.role}
          etag={role.data.etag}
          subject={subject}
        />
      ) : (
        <>
          <PageHeader title={title} />
          {role.isPending ? (
            <Spinner />
          ) : missing ? (
            <FormAlert message={t('roles.notFound')} />
          ) : (
            <FormAlert message={errorMessage(role.error)} />
          )}
        </>
      )}
    </Page>
  );
}

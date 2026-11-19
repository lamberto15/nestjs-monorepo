import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page } from '@/components/page-header';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';

export const Route = createFileRoute('/_app/access/roles/new')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: NewRole,
});

function NewRole() {
  const { t } = useTranslation('access');
  return (
    <Page>
      <RoleForm title={t('roles.newTitle')} />
    </Page>
  );
}

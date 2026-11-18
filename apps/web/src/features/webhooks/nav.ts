import { WebhookIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'developers',
  order: 30,
  to: '/webhooks',
  label: 'webhooks:nav.title',
  icon: WebhookIcon,
  feature: 'webhooks',
  // Either: the page shows what each lets you manage.
  permission: ['Webhooks.manageEndpoints', 'Webhooks.manageSenders'],
} satisfies NavContribution;

import { z } from 'zod';
import { defineNotifications } from './notifications.types.js';

/**
 * The test notification of `POST /notifications/test` (outside production),
 * so the bell, the live count and the mail can be tried by hand and driven
 * by the module's tests. Declared only where the route is on.
 */
export const TEST_NOTIFICATIONS = defineNotifications([
  {
    type: 'notification.test',
    email: 'immediate',
    push: true,
    data: z.object({ at: z.iso.datetime() }),
  },
]);

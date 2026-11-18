import type { QueryClient } from '@tanstack/react-query';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
import { PageTitle, RouteFocus } from '@/components/route-accessibility';
import type { Session } from '@/lib/session';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  session: Session;
}>()({
  component: Root,
});

function Root() {
  return (
    <>
      <PageTitle />
      <RouteFocus />
      {/* Inside the router, as nuqs documents it: the adapter reads the
          router's history (useRouter), so it can't wrap <RouterProvider>. */}
      <NuqsAdapter>
        <Outlet />
      </NuqsAdapter>
      {/* Development only, and not under Vitest (its mode is 'test', DEV is
          true there): the devtools inject a stylesheet on every mount, and
          jsdom walks every rule for each getByRole, so a test file ran
          slower with each test (2 s for the first, 35 s for the last). */}
      {import.meta.env.DEV && import.meta.env.MODE !== 'test' && (
        <>
          <TanStackRouterDevtools />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </>
      )}
    </>
  );
}

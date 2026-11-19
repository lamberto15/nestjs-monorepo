import type { Page } from '@playwright/test';
import { account } from './accounts';
import { expect, test, asRole } from './fixtures';

// Serious and critical violations fail, and so do the landmark, heading and
// skip-link rules (LANDMARK_RULES in fixtures.ts); all of them are attached to
// the test and listed in the job summary (scripts/axe-summary.mjs).

// The page's own h1 is what a scan waits for: the route has rendered.
const pageHeading = (page: Page) =>
  page.getByRole('heading', { level: 1 }).first();

const SIGNED_OUT = ['/sign-in', '/sign-up', '/forgot-password'];

const SIGNED_IN = [
  '/',
  '/settings',
  '/account/profile',
  '/account/preferences',
  '/account/security',
  '/account/notifications',
  '/account/privacy',
  '/account/watching',
  '/access/roles',
  '/access/roles/new',
];

/** A scan name from a path: "/account/profile" becomes "account-profile". */
const nameOf = (path: string, variant = '') =>
  [path.replace(/^\/|\/$/g, '').replaceAll('/', '-') || 'dashboard', variant]
    .filter(Boolean)
    .join('-');

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of SIGNED_OUT) {
    test(path, async ({ page, expectAccessible }) => {
      await page.goto(path);
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, nameOf(path));
    });
  }

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('sign-in', async ({ page, expectAccessible }) => {
      await page.goto('/sign-in');
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, 'sign-in-phone');
    });
  });
});

test.describe('signed in as the administrator', () => {
  test.use(asRole('administrator'));

  for (const path of SIGNED_IN) {
    test(path, async ({ page, expectAccessible }) => {
      await page.goto(path);
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, nameOf(path));
    });
  }

  test.describe('dark theme', () => {
    test.beforeEach(async ({ page }) => {
      // The theme the browser remembers (the ThemeProvider's storage key).
      await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    });

    for (const path of [
      '/',
      '/settings',
      '/access/roles',
      '/access/roles/new',
    ]) {
      test(path, async ({ page, expectAccessible }) => {
        await page.goto(path);
        await expect(page.locator('html')).toHaveClass(/dark/);
        await expect(pageHeading(page)).toBeVisible();
        await expectAccessible(page, nameOf(path, 'dark'));
      });
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    for (const path of ['/', '/account/profile']) {
      test(path, async ({ page, expectAccessible }) => {
        await page.goto(path);
        await expect(pageHeading(page)).toBeVisible();
        await expectAccessible(page, nameOf(path, 'phone'));
      });
    }
  });

  // Reflow (WCAG 1.4.10): narrowing the window (or zooming in) under the
  // two-column breakpoint, the dashboard's cards shrink with it rather than
  // keeping their width and scrolling the page sideways.
  test('the dashboard reflows when the window narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
  });

  // A wide table scrolls in its own box, not the page: the header's search
  // and bell stay on screen (the inset is a flex child, so it needs min-w-0).
  for (const path of ['/audit', '/sign-ins', '/access/roles']) {
    test(`${path} never scrolls the page sideways on a laptop`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(path);
      await expect(page.getByRole('table')).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        )
        .toBe(0);
    });
  }

  test.describe('open overlays', () => {
    // Only what the overlay holds is scanned: the page behind it is inert
    // while a modal is open, and the page-level rules are covered above.
    test('the search dialog', async ({ page, expectAccessible }) => {
      await page.goto('/');
      await expect(pageHeading(page)).toBeVisible();
      await page.getByRole('button', { name: 'Search (Ctrl+K)' }).click();
      await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
      await expectAccessible(page, 'search-dialog', {
        scope: '[role="dialog"]',
      });
    });

    test('the user menu', async ({ page, expectAccessible }) => {
      await page.goto('/');
      await expect(pageHeading(page)).toBeVisible();
      await page
        .getByRole('button', { name: account('administrator').email })
        .click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expectAccessible(page, 'user-menu', { scope: '[role="menu"]' });
    });
  });
});

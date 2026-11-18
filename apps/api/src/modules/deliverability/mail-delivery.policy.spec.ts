import type { QuotasService } from '../quotas/quotas.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { MailDeliveryRules } from './mail-delivery.policy.js';

const scope = vi.hoisted(() => ({ tenantId: null as string | null }));
vi.mock('../../core/tenancy/tenant-scope.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../core/tenancy/tenant-scope.js')
  >()),
  currentTenantScope: () => ({
    tenantId: scope.tenantId,
    acrossTenants: false,
  }),
}));

/** The quota's counter, as QuotasService keeps it: nothing is taken past the limit. */
function rules(options: {
  limit: number | null;
  percent?: number;
  mode?: string;
}) {
  let used = 0;
  const quotas = {
    limitOf: async () => options.limit,
    used: async () => used,
    tryConsume: async () => {
      const allowed = options.limit === null || used + 1 <= options.limit;
      if (allowed) used += 1;
      return { allowed, used, limit: options.limit, resetsAt: new Date() };
    },
  } as unknown as QuotasService;
  const settings = {
    get: async (declaration: { key: string }) =>
      declaration.key === 'mail.delivery'
        ? (options.mode ?? 'all')
        : (options.percent ?? 90),
  } as unknown as SettingsService;
  return { rules: new MailDeliveryRules(settings, quotas), used: () => used };
}

describe('MailDeliveryRules', () => {
  beforeEach(() => {
    scope.tenantId = 'tenant-a';
  });

  it('reads the mode from the setting', async () => {
    expect(await rules({ limit: null, mode: 'off' }).rules.mode()).toBe('off');
  });

  it('counts mail and withholds nothing without a limit', async () => {
    const { rules: r, used } = rules({ limit: null });
    expect(await r.consume({ essential: false })).toBe(true);
    expect(await r.consume({ essential: true })).toBe(true);
    expect(used()).toBe(2);
  });

  it('stops non-essential mail past the percentage of the limit; essential mail still goes', async () => {
    const { rules: r, used } = rules({ limit: 4, percent: 50 });
    expect(await r.consume({ essential: false })).toBe(true);
    expect(await r.consume({ essential: false })).toBe(true);
    expect(await r.consume({ essential: false })).toBe(false);
    // The withheld one used none of the allowance.
    expect(used()).toBe(2);
    expect(await r.consume({ essential: true })).toBe(true);
    expect(await r.consume({ essential: true })).toBe(true);
    // At the limit the count stops, the essential mail still goes.
    expect(await r.consume({ essential: true })).toBe(true);
    expect(used()).toBe(4);
    expect(await r.consume({ essential: false })).toBe(false);
  });

  it('applies the whole limit at 100 percent', async () => {
    const { rules: r } = rules({ limit: 1, percent: 100 });
    expect(await r.consume({ essential: false })).toBe(true);
    expect(await r.consume({ essential: false })).toBe(false);
  });

  it('applies no budget outside a tenant', async () => {
    scope.tenantId = null;
    const { rules: r, used } = rules({ limit: 1 });
    expect(await r.consume({ essential: false })).toBe(true);
    expect(used()).toBe(0);
  });
});

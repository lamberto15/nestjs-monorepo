import type { UnitType } from '../iam/organization/organization.tables.js';

/**
 * What the demo seed creates (DemoSeeder): a tenant of its own, a small
 * company with three organizational units, and people in the template's
 * seed roles (iam/access/access.permissions.ts). Features add their own
 * demo data in their own seeders; the database gives the ids.
 */

/** The demo's tenant: never the operators', except with TENANCY=single, where the seed fills the one tenant there is. */
export const DEMO_TENANT = { name: 'Demo Company', slug: 'demo' };

/** The demo users' addresses: example.com is reserved, nothing is ever delivered. */
export const DEMO_EMAIL_DOMAIN = 'demo.example.com';

export interface DemoUnit {
  key: string;
  type: UnitType;
  name: string;
  /** The parent's key. */
  parent?: string;
}

export interface DemoUser {
  name: string;
  /** Roles' keys (`roles.key`); `administrator` makes the tenant's administrator. */
  roles: string[];
  /** Units' keys: those they are a member of. */
  units: string[];
  /** Those of `units` they lead. */
  leads?: string[];
}

// Parents come first.
export const DEMO_UNITS: DemoUnit[] = [
  { key: 'sales', type: 'division', name: 'Sales' },
  { key: 'sales-north', type: 'team', name: 'Sales North', parent: 'sales' },
  { key: 'engineering', type: 'department', name: 'Engineering' },
];

// The browser tests find their accounts by role (apps/web-e2e/test/accounts.ts):
// the administrator, one unit lead, editors with that role alone, one viewer.
export const DEMO_USERS: DemoUser[] = [
  {
    name: 'Noah Fischer',
    roles: ['administrator', 'editor'],
    units: [],
  },
  {
    name: 'Maya Patel',
    roles: ['editor', 'unit-lead'],
    units: ['sales'],
    leads: ['sales'],
  },
  {
    name: 'Lucas Moreau',
    roles: ['editor', 'unit-lead'],
    units: ['engineering'],
    leads: ['engineering'],
  },
  { name: 'Jonas Berg', roles: ['editor'], units: ['sales-north'] },
  { name: 'Amara Okafor', roles: ['editor'], units: ['sales-north'] },
  { name: 'Sofia Rossi', roles: ['editor'], units: ['engineering'] },
  { name: 'Elena Novak', roles: ['viewer'], units: [] },
];

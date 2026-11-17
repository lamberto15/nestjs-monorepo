import {
  accountFileKey,
  isTenantFileKey,
  tenantFileKey,
} from './storage.keys.js';

const ID = '0197a6f0-1111-7222-8333-944455556666';

describe('file keys', () => {
  it("puts a tenant's files under its prefix", () => {
    expect(tenantFileKey(ID, '/a/b.pdf')).toBe(`tenants/${ID}/a/b.pdf`);
    expect(accountFileKey(ID, 'export.zip')).toBe(`accounts/${ID}/export.zip`);
  });

  it('refuses an id that is not a UUID', () => {
    expect(() => tenantFileKey('../x', 'a')).toThrow(TypeError);
    expect(() => accountFileKey('x', 'a')).toThrow(TypeError);
  });

  it("recognizes only the tenant's own keys", () => {
    expect(isTenantFileKey(ID, `tenants/${ID}/a`)).toBe(true);
    expect(isTenantFileKey(ID, `tenants/${ID}/../b`)).toBe(false);
    expect(isTenantFileKey(ID, 'tenants/other/a')).toBe(false);
  });
});

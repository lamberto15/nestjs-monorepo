import {
  effectiveSettings,
  offered,
  preferencesSchema,
} from './notifications.preferences.js';
import type { NotificationTypeDeclaration } from './notifications.types.js';

const plain: NotificationTypeDeclaration = {
  type: 'note.changed',
  email: 'daily',
};
const security: NotificationTypeDeclaration = {
  type: 'security.signIn',
  email: 'immediate',
  mandatory: true,
};
const optional: NotificationTypeDeclaration = { type: 'note.shared' };

describe('effectiveSettings', () => {
  it('is the override when valid, else the default, else off', () => {
    expect(
      effectiveSettings(plain, { email: 'hourly' }, ['email', 'push']),
    ).toEqual({
      email: 'hourly',
      push: false,
    });
    expect(effectiveSettings(plain, undefined, ['email'])).toEqual({
      email: 'daily',
    });
    expect(effectiveSettings(optional, { email: 'often' }, ['email'])).toEqual({
      email: false,
    });
  });

  it("keeps a mandatory type's default where an override switches it off", () => {
    expect(effectiveSettings(security, { email: false }, ['email'])).toEqual({
      email: 'immediate',
    });
    expect(effectiveSettings(security, { email: 'daily' }, ['email'])).toEqual({
      email: 'daily',
    });
  });

  it('offers a recipient who may set nothing nothing', () => {
    expect(effectiveSettings(plain, { email: 'hourly' }, [])).toEqual({});
  });
});

describe('preferencesSchema', () => {
  const schema = preferencesSchema([plain, security, optional], ['email']);
  const issues = (value: unknown) => {
    const result = schema.safeParse(value);
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join('.'));
  };

  it('takes the declared types and channels', () => {
    expect(
      issues({ 'note.changed': { email: 'hourly' }, 'note.shared': {} }),
    ).toEqual([]);
    expect(issues({})).toEqual([]);
  });

  it('names what it refuses', () => {
    expect(issues({ 'nope.type': { email: false } })).toEqual(['nope.type']);
    expect(issues({ 'note.changed': { push: true } })).toEqual([
      'note.changed.push',
    ]);
    expect(issues({ 'note.changed': { email: 'often' } })).toEqual([
      'note.changed.email',
    ]);
  });

  it("refuses switching off a mandatory type's channel that is on by default, and nothing else", () => {
    expect(issues({ 'security.signIn': { email: false } })).toEqual([
      'security.signIn.email',
    ]);
    expect(issues({ 'security.signIn': { email: 'daily' } })).toEqual([]);
    expect(issues({ 'note.changed': { email: false } })).toEqual([]);
  });
});

describe('a fixed channel', () => {
  const alert: NotificationTypeDeclaration = {
    type: 'security.passkey-added',
    email: false,
    fixed: ['email'],
    mandatory: true,
  };

  it('is not offered, keeps its default whatever was stored, and is refused by name', () => {
    expect(offered(alert, ['email', 'push'])).toEqual(['push']);
    expect(
      effectiveSettings(alert, { email: 'immediate', push: true }, [
        'email',
        'push',
      ]),
    ).toEqual({ email: false, push: true });
    const parsed = preferencesSchema([alert], ['email', 'push']).safeParse({
      'security.passkey-added': { email: 'immediate' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'security.passkey-added.email',
    ]);
  });
});

import type { Secrets } from '../../core/secrets/secrets.service.js';
import {
  UnsubscribeLinks,
  unsubscribeHeaders,
} from './notifications.unsubscribe.js';

const links = (key = 'a-fixed-signing-key-of-32-bytes!!') =>
  new UnsubscribeLinks(
    { loadOrCreate: () => Promise.resolve(key) } as unknown as Secrets,
    { appUrl: 'https://api.example.com' },
  );

describe('UnsubscribeLinks', () => {
  it('names the user and what to switch off, once signed', async () => {
    const link = links();
    expect(
      await link.verify(await link.signType('u1', 'note.changed')),
    ).toEqual({
      userId: 'u1',
      type: 'note.changed',
    });
    expect(
      await link.verify(await link.signDigests('u1', ['daily', 'daily'])),
    ).toEqual({
      userId: 'u1',
      digests: ['daily'],
    });
  });

  it('refuses a token that was changed, made with another key, expired, or malformed', async () => {
    const link = links();
    const token = await link.signType('u1', 'note.changed');
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u2', nt: 'note.changed', exp: Date.now() + 1e9 }),
    ).toString('base64url');
    expect(await link.verify(`${forged}.${mac}`)).toBeNull();
    expect(
      await links('another-signing-key-of-32-bytes!').verify(token),
    ).toBeNull();
    expect(await link.verify(token, Date.now() + 366 * 86_400_000)).toBeNull();
    for (const bad of ['', 'x', `${body}`, `${token}.extra`, '.']) {
      expect(await link.verify(bad)).toBeNull();
    }
  });

  it("builds the one-click URL and the page URL on the API's address", async () => {
    const link = links();
    expect(link.url('t')).toBe(
      'https://api.example.com/v1/notifications/unsubscribe/t',
    );
    expect(link.pageUrl('a b')).toBe(
      'https://api.example.com/unsubscribe?token=a%20b',
    );
  });
});

describe('unsubscribeHeaders', () => {
  it('adds the RFC 8058 pair for an https link, and the mailbox when given', () => {
    expect(unsubscribeHeaders('https://x.example/u/t')).toEqual({
      'List-Unsubscribe': '<https://x.example/u/t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(
      unsubscribeHeaders('https://x.example/u/t', 'off@x.example')[
        'List-Unsubscribe'
      ],
    ).toBe('<https://x.example/u/t>, <mailto:off@x.example>');
  });

  it('adds nothing for http: the RFC needs https', () => {
    expect(unsubscribeHeaders('http://localhost:3000/u/t')).toEqual({});
  });
});

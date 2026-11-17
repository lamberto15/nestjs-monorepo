import { destinationAllowed, destinationRefusal } from './webhook.transport.js';

const off = { allowLoopback: false, worker: true, retentionDays: 30 };
const on = { ...off, allowLoopback: true };

describe('the webhook destination rules', () => {
  it('refuses private, loopback, link-local and metadata addresses', () => {
    for (const address of [
      '10.0.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
    ]) {
      expect(destinationAllowed(address, off), address).toBe(false);
    }
    expect(destinationAllowed('93.184.215.14', off)).toBe(true);
  });

  it('allows 127.0.0.1 alone with WEBHOOKS_ALLOW_LOOPBACK', () => {
    expect(destinationAllowed('127.0.0.1', on)).toBe(true);
    expect(destinationAllowed('127.0.0.2', on)).toBe(false);
    expect(destinationAllowed('10.0.0.1', on)).toBe(false);
  });

  it('refuses an endpoint URL with such an address, or plain http', async () => {
    expect(
      await destinationRefusal('https://169.254.169.254/latest', off),
    ).toMatch(/refused/);
    expect(await destinationRefusal('https://[::1]/hooks', off)).toMatch(
      /refused/,
    );
    expect(await destinationRefusal('http://93.184.215.14/hooks', off)).toMatch(
      /http/,
    );
    expect(
      await destinationRefusal('http://127.0.0.1:8080/hooks', off),
    ).toMatch(/refused/);
    expect(
      await destinationRefusal('http://127.0.0.1:8080/hooks', on),
    ).toBeUndefined();
    expect(
      await destinationRefusal('https://93.184.215.14/hooks', off),
    ).toBeUndefined();
    // Not a URL: left to the package's own message.
    expect(await destinationRefusal('nope', off)).toBeUndefined();
  });
});

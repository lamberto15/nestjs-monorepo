import { NotFoundException } from '@nestjs/common';
import {
  contactUri,
  SecurityTxtController,
} from './security-txt.controller.js';

const controller = (config: {
  securityContact?: string;
  securityTxtExpires?: string;
}) =>
  new SecurityTxtController({
    root: undefined,
    filesOrigins: [],
    securityContact: config.securityContact,
    securityTxtExpires: config.securityTxtExpires,
  });

describe('security.txt', () => {
  it('is a 404 without SECURITY_CONTACT', () => {
    expect(() => controller({}).securityTxt()).toThrow(NotFoundException);
  });

  it('expires 180 days ahead unless a date is set', () => {
    const body = controller({
      securityContact: 'https://example.com/security',
    }).securityTxt();
    expect(body).toContain('Contact: https://example.com/security\n');
    const expires = Date.parse(/Expires: (.+)/.exec(body)![1]!);
    expect(expires - Date.now()).toBeGreaterThan(179 * 86_400_000);
    expect(expires - Date.now()).toBeLessThan(181 * 86_400_000);
  });

  it('makes a bare address a mailto: URI', () => {
    expect(contactUri('security@example.com')).toBe(
      'mailto:security@example.com',
    );
    expect(contactUri('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

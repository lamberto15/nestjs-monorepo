import type { Type } from '@nestjs/common';

const ESSENTIAL = Symbol('essential-mail');

/**
 * Marks a mail class as essential: requested by the recipient (a password
 * reset, a sign-in link, an address confirmation) or a notice they must get
 * (their account's deletion). With `MAIL_DELIVERY=essential` only these
 * leave; everything else (notifications, digests, reports) is not essential.
 */
export const EssentialMail = (): ClassDecorator => (target) => {
  Reflect.defineMetadata(ESSENTIAL, true, target);
};

/** Whether a mail class carries `@EssentialMail()`. */
export const isEssentialMail = (mail: Type<unknown>) =>
  Reflect.getMetadata(ESSENTIAL, mail) === true;

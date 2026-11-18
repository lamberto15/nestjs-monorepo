import {
  BadRequestException,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { I18nService, t } from '@nestjs/i18n';

/**
 * A kind of consent the app asks for. Its texts are in the catalogs,
 * `personalData.consentKinds.<kind>.label` and `.description`.
 */
export interface ConsentKindDeclaration {
  /** `terms`, `privacy`, `marketing`. */
  kind: string;
  /** The version in force (`2026-01`): the only one accepted. Bump it with a new text. */
  version: string;
  /**
   * Needed to use the service (the terms, the privacy policy): a
   * contract's, not a consent one withdraws and stays; withdrawing one is
   * refused (409 `consent_required`), deleting the account ends it.
   */
  required: boolean;
}

/**
 * The template's kinds, as the web app asks for them. An app changes them
 * here, with their texts in i18n/en.json.
 */
export const CONSENT_KINDS: readonly ConsentKindDeclaration[] = [
  { kind: 'terms', version: '2026-01', required: true },
  { kind: 'privacy', version: '2026-01', required: true },
  { kind: 'marketing', version: '2026-01', required: false },
];

/** A kind's name, as declared and as the routes take it. */
export const CONSENT_KIND_PATTERN = /^[a-z][a-zA-Z0-9-]{0,49}$/;

/** The declared kinds: checked at start, listed with their texts, the judge of what may be accepted. */
@Injectable()
export class ConsentKinds implements OnApplicationBootstrap {
  private readonly byKind = new Map(
    CONSENT_KINDS.map((declaration) => [declaration.kind, declaration]),
  );

  constructor(private readonly i18n: I18nService) {}

  onApplicationBootstrap() {
    for (const { kind, version } of CONSENT_KINDS) {
      if (!CONSENT_KIND_PATTERN.test(kind) || !version.trim()) {
        throw new Error(`Consent kind "${kind}": a name and a version.`);
      }
      for (const part of ['label', 'description']) {
        const key = `personalData.consentKinds.${kind}.${part}`;
        if (!this.i18n.exists(key, this.i18n.defaultLocale)) {
          throw new Error(`The catalogs have no ${key}.`);
        }
      }
    }
  }

  get(kind: string) {
    return this.byKind.get(kind);
  }

  /** The kinds, in declaration order, with their texts in the request's language. */
  list() {
    return CONSENT_KINDS.map(({ kind, version, required }) => ({
      kind,
      version,
      required,
      label: this.i18n.translate(`personalData.consentKinds.${kind}.label`),
      description: this.i18n.translate(
        `personalData.consentKinds.${kind}.description`,
      ),
    }));
  }

  /** A declared kind at its current version, else a 400 naming the field. */
  assertAcceptable(kind: string, version: string) {
    const declared = this.byKind.get(kind);
    const refuse = (path: string, message: string) =>
      new BadRequestException({
        code: 'validation_failed',
        message: t('personalData.consentRefused'),
        errors: [{ path, message }],
      });
    if (!declared) {
      throw refuse(
        'kind',
        t('personalData.consentUnknownKind', {
          args: { kinds: [...this.byKind.keys()].join(', ') },
        }),
      );
    }
    if (declared.version !== version) {
      throw refuse(
        'version',
        t('personalData.consentOtherVersion', {
          args: { version: declared.version },
        }),
      );
    }
    return declared;
  }
}

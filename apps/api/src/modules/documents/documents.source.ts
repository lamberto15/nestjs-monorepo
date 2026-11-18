import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { RecordDeclaration } from '../records/record.js';
import { DOCUMENT_TEMPLATES_DIR } from './document-templates.js';

/** How a record's PDF is made: the template's name and the folder it is in. */
export interface DocumentOptions {
  /** A template in `dir` (`invoice`: `invoice.html`, or `invoice.<locale>.html`). Default: the module's `pdf-record`, a table of the record's fields. */
  template?: string;
  /** The folder of the template (a `templates/` folder of the feature). Default: this module's. */
  dir?: string;
}

/**
 * A record that issues PDFs (`DocumentsModule.forRecord(NOTE, { template })`),
 * found by discovery. Its name in a document is the record's collection path.
 */
export class DocumentSourceRegistration {
  readonly template: { name: string; dir: string };

  constructor(
    readonly record: RecordDeclaration,
    options: DocumentOptions = {},
  ) {
    this.template = {
      name: options.template ?? 'pdf-record',
      dir: options.dir ?? DOCUMENT_TEMPLATES_DIR,
    };
  }

  /** Nest hashes a dynamic module's metadata: the subject names the record. */
  toJSON() {
    return `document-source:${this.record.subject}`;
  }
}

/** The records that issue PDFs, by subject and by path. */
@Injectable()
export class DocumentSources implements OnModuleInit {
  private readonly bySubject = new Map<string, DocumentSourceRegistration>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const found: unknown = wrapper.instance;
      if (found instanceof DocumentSourceRegistration) {
        this.bySubject.set(found.record.subject, found);
      }
    }
  }

  /** The registration of a subject; a document row of a removed one is a bug. */
  of(subject: string) {
    const source = this.bySubject.get(subject);
    if (!source) throw new Error(`No record issues documents as ${subject}.`);
    return source;
  }
}

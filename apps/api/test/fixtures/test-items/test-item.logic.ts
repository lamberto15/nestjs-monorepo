import { Injectable } from '@nestjs/common';
import type { RecordDeclaration } from '../../../src/modules/records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
  type RecordValues,
} from '../../../src/modules/records/record-extension.js';

/**
 * The test items' own write logic: `words` (read-only) counted from
 * `body` on every write, whoever writes (the routes, bulk, imports,
 * automations, a revision restored, a recurring create): a feature's
 * logic of every write is its own `@RecordExtension()`, in its own module.
 */
@RecordExtension()
@Injectable()
export class TestItemLogic implements RecordHooks {
  constructor(@InjectRecord() readonly record: RecordDeclaration) {}

  async creating({ values }: { values: RecordValues }) {
    return { words: wordsOf(values.body) };
  }

  async updating({ changes }: { changes: RecordValues }) {
    if ('body' in changes) return { words: wordsOf(changes.body) };
  }
}

const wordsOf = (text: unknown) =>
  typeof text === 'string' && text
    ? text.split(/\s+/).filter(Boolean).length
    : null;

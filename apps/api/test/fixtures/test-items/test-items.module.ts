import { type DynamicModule, Module } from '@nestjs/common';
import type { z } from 'zod';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { TestMarksModule } from './marks/marks.js';
import { MARKS_BODY, MARKS_RESPONSE } from './marks/marks.schemas.js';
import { TEST_ITEM_LIST } from './test-item.list.js';
import { TEST_ITEM_PERMISSIONS } from './test-item.permissions.js';
import { TestItemLogic } from './test-item.logic.js';
import { TestItemPolicy } from './test-item.policy.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItemsController } from './test-items.controller.js';
import { TestItemsService } from './test-items.service.js';
import { testItems } from './test-items.tables.js';

/** What an add-on's test gives testItemsModule(). */
export interface TestItemsOptions {
  /** The add-ons' modules: `TagsModule.forRecord(TEST_ITEM)`. */
  imports?: NonNullable<DynamicModule['imports']>;
  /** What they show on a record (their exported response shape). */
  response?: z.ZodRawShape;
  /** What they read from the create and update bodies. */
  body?: z.ZodRawShape;
  /** A stock quota on test items (RecordsModule.forFeature's `quota`). */
  quota?: { label: string; default?: number | null };
}

/** The host of a testItemsModule(). */
@Module({})
class TestItemsHost {}

/**
 * Test items with the add-ons an e2e test needs: their permissions, their
 * record (store, presenter, restore route, registration), the routes, and
 * each add-on an import, as a feature module has them. Boot it with
 * `bootModules(...testItemModules(), testItemsModule({ … }))` (test/records.ts).
 */
export function testItemsModule({
  imports = [],
  response,
  body,
  quota,
}: TestItemsOptions = {}): DynamicModule {
  const schemas = recordSchemas(TEST_ITEM, { response, body });
  return {
    module: TestItemsHost,
    imports: [
      AccessModule.forFeature(TEST_ITEM_PERMISSIONS),
      RecordsModule.forFeature(TEST_ITEM, {
        table: testItems,
        list: TEST_ITEM_LIST,
        schemas,
        policy: TestItemPolicy,
        ...(quota && { quota }),
      }),
      ...imports,
    ],
    controllers: [testItemsController(schemas)],
    providers: [TestItemsService, TestItemPolicy, TestItemLogic],
  };
}

/** Test items with the marks add-on: the engine's own tests (test-items.e2e-spec.ts). */
export const testItemsWithMarks = () =>
  testItemsModule({
    imports: [TestMarksModule.forRecord(TEST_ITEM)],
    response: MARKS_RESPONSE,
    body: MARKS_BODY,
  });

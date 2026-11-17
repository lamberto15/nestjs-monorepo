import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import type { Database } from '../../src/core/database/database.js';
import { testItems } from './test-items.tables.js';

/** Writes and reads test items through the current transaction, as every service does. */
@Injectable()
export class TestItemsService {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async add(name: string, parentId?: string) {
    const [row] = await this.db
      .insert(testItems)
      .values({ name, parentId })
      .returning();
    return row!;
  }

  async names() {
    const rows = await this.db
      .select({ name: testItems.name })
      .from(testItems)
      .orderBy(testItems.name);
    return rows.map((row) => row.name);
  }
}

/** Another service calling TestItemsService in its transactions, never handing it `tx`. */
@Injectable()
export class TestItemsBatch {
  constructor(private readonly items: TestItemsService) {}

  @Transactional()
  async addAll(names: string[], fail?: Error) {
    for (const name of names) {
      await this.items.add(name);
    }
    if (fail) {
      throw fail;
    }
  }

  /** Two batches, the second nested in the first's transaction (it joins it). */
  @Transactional()
  async addTwice(first: string[], second: string[], fail?: Error) {
    await this.addAll(first);
    await this.addAll(second);
    if (fail) {
      throw fail;
    }
  }
}

@Module({
  providers: [TestItemsService, TestItemsBatch],
  exports: [TestItemsService, TestItemsBatch],
})
export class TestItemsModule {}

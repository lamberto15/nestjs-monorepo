import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import {
  ReadinessCheck,
  type ReadinessIndicator,
} from '../health/readiness.js';
import type { Database } from './database.js';

@Injectable()
@ReadinessCheck('database')
export class DatabaseReadiness implements ReadinessIndicator {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async check() {
    // A ping has no query-builder form.
    await this.db.execute(sql`select 1`);
  }
}

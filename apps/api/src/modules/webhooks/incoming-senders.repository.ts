import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { incomingWebhookSenders } from './webhooks.tables.js';

export type Sender = typeof incomingWebhookSenders.$inferSelect;
type NewSender = typeof incomingWebhookSenders.$inferInsert;

/**
 * The incoming webhook senders' queries, in the tenant the query runs in
 * and the ambient transaction (`@InjectTransaction()`): the service keeps
 * the rules, the secrets' sealing and the audit.
 */
@Injectable()
export class IncomingSendersRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  list() {
    return this.db
      .select()
      .from(incomingWebhookSenders)
      .orderBy(asc(incomingWebhookSenders.name));
  }

  async findById(id: string): Promise<Sender | undefined> {
    const [row] = await this.db
      .select()
      .from(incomingWebhookSenders)
      .where(eq(incomingWebhookSenders.id, id));
    return row;
  }

  async findByName(name: string): Promise<Sender | undefined> {
    const [row] = await this.db
      .select()
      .from(incomingWebhookSenders)
      .where(eq(incomingWebhookSenders.name, name));
    return row;
  }

  async insert(values: NewSender) {
    const [created] = await this.db
      .insert(incomingWebhookSenders)
      .values(values)
      .returning();
    return created!;
  }

  async update(id: string, values: Partial<NewSender>) {
    const [updated] = await this.db
      .update(incomingWebhookSenders)
      .set(values)
      .where(eq(incomingWebhookSenders.id, id))
      .returning();
    return updated!;
  }

  async delete(id: string) {
    await this.db
      .delete(incomingWebhookSenders)
      .where(eq(incomingWebhookSenders.id, id));
  }
}

import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../../iam/access/access.service.js';
import {
  type ActionContext,
  AutomationAction,
  type AutomationActionHandler,
  type PlannedAction,
} from '../automations/automation-actions.js';
import type { RecordRegistration } from '../records/records.service.js';
import { TagsRegistry } from './tags.registry.js';
import { TagsRepository } from './tags.repository.js';
import { TagsService } from './tags.service.js';

const params = z.object({
  tagId: z.uuid().describe('A tag of the subject (GET /v1/tags).'),
});
type Params = z.infer<typeof params>;

/**
 * `{ tagId }`: adds a tag to the record, as the rule's owner (who needs
 * `update` on it), keeping the tags it has. Only for records that take tags.
 */
@AutomationAction('addTag')
@Injectable()
export class AddTagAction implements AutomationActionHandler<Params> {
  readonly params = params;

  constructor(
    private readonly repository: TagsRepository,
    private readonly registry: TagsRegistry,
    private readonly tagsService: TagsService,
    private readonly access: AccessService,
  ) {}

  supports(record: RecordRegistration) {
    return this.registry.has(record.declaration.subject);
  }

  private tag(subject: string, id: string) {
    return this.repository.findOfSubject(subject, id);
  }

  async check(record: RecordRegistration, { tagId }: Params) {
    const { subject } = record.declaration;
    return (await this.tag(subject, tagId))
      ? []
      : [{ path: 'tagId', message: `No ${subject} tag ${tagId}.` }];
  }

  async plan({
    record,
    principal,
    row,
    params: { tagId },
  }: ActionContext<Params>): Promise<PlannedAction> {
    const { subject } = record.declaration;
    const tag = await this.tag(subject, tagId);
    if (!tag) return { allowed: false, reason: 'unknown_tag', detail: tagId };
    if (!(await this.access.can(principal, 'update', subject, row))) {
      return { allowed: false, reason: 'forbidden', detail: tag.name };
    }
    return {
      allowed: true,
      detail: tag.name,
      apply: async () => {
        const current = (await this.tagsService.tagsOf(subject, [row.id])).get(
          row.id,
        )!;
        if (current.some((t) => t.id === tag.id)) return;
        await this.tagsService.setTags(principal, subject, row.id, [
          ...current.map((t) => t.id),
          tag.id,
        ]);
      },
    };
  }
}

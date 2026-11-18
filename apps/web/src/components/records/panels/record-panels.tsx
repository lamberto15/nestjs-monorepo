import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo/ui/components/tabs';
import { useTranslation } from 'react-i18next';
import { useCan, useFeature, type Permission } from '@/lib/features';
import { useListDescription } from '@/lib/list-query';
// capability:tags begin
import type { Tag } from '@/features/tags/tags';
import { TagsPanel } from '@/features/tags/tags-panel';
// capability:tags end
// capability:attachments begin
import { useAttachmentsLive } from '@/features/attachments/api';
import { AttachmentsPanel } from '@/features/attachments/attachments-panel';
// capability:attachments end
// capability:comments begin
import { useCommentsLive } from '@/features/comments/api';
import { CommentsPanel } from '@/features/comments/comments-panel';
// capability:comments end
// capability:merge begin
import { DuplicatesPanel } from '@/features/merge/duplicates-panel';
// capability:merge end
// capability:revisions begin
import { RevisionsPanel } from '@/features/revisions/revisions-panel';
// capability:revisions end
import { DocumentsPanel } from './documents-panel';
import { RelatedPanel } from './related-panel';

/**
 * The panels of a record's detail page, each shown only when the subject
 * takes it (`capabilities` of `GET /v1/lists/{subject}`, from the feature's
 * `<item>.record.ts`) and the user may read the record, and writable only
 * with `<Subject>.update` (the API checks the same):
 *
 *   <RecordPanels subject="Invoice" path="/v1/invoices/{id}" id={invoice.id}
 *     tags={invoice.tags} canUpdate={can.update} />
 *
 * `path` is the record's route with `{id}`; the panels' routes hang off it.
 * `tags` are the record's own (they come with it). `canUpdate` is the
 * record's own `can.update` (useRecordCan) when the page has it: the panels'
 * writes take the same check as the record's PATCH (its conditions), so a
 * record the user may not change shows its panels read-only. Left out, the
 * permission `<Subject>.update` decides. The record's queries
 * (`recordKeys`, list path = `path` without `/{id}`) are refreshed after a
 * tag change or a restore. Uploads are held to the list's
 * `attachmentLimits`.
 *
 * The related tab lists the records that refer to this one (`related` of
 * `GET /v1/lists/{subject}`: their `ref` fields), each relation's newest,
 * as their own list shows them to the user.
 *
 * The duplicates tab (the subject's `merge` capability: docs/merging.md)
 * lists the records the API finds alike, and merges one into this record.
 *
 * The documents tab (a PDF of the record: docs/documents.md) needs the
 * subject's `pdf` capability and the `documents` feature.
 *
 * Each panel's module reloads its panel on the record's realtime events
 * (its `use…Live` hook, docs/webhooks-and-realtime.md, "Record events").
 */
export function RecordPanels(props: {
  subject: string;
  path: `${string}/{id}`;
  id: string;
  // capability:tags begin
  tags?: readonly Pick<Tag, 'id' | 'name' | 'color'>[];
  // capability:tags end
  canUpdate?: boolean;
}) {
  const { t } = useTranslation('records');
  const documentsOn = useFeature('documents');
  const canRead = useCan(`${props.subject}.read` as Permission);
  const mayUpdate = useCan(`${props.subject}.update` as Permission);
  const canUpdate = props.canUpdate ?? mayUpdate;
  const description = useListDescription(props.subject, canRead).data;
  const listPath = props.path.replace(/\/\{id\}$/, '');

  // capability:comments begin
  useCommentsLive(props.subject, props.path, props.id);
  // capability:comments end
  // capability:attachments begin
  useAttachmentsLive(props.subject, props.path, props.id);
  // capability:attachments end

  // Nothing until the subject says what it takes.
  if (!canRead || !description) {
    return null;
  }
  const { capabilities, attachmentLimits } = description;
  // Absent from an older API's answer.
  const related = description.related ?? [];
  const tabs = [
    // capability:comments begin
    capabilities.comments && 'comments',
    // capability:comments end
    // capability:attachments begin
    capabilities.attachments && attachmentLimits && 'attachments',
    // capability:attachments end
    // capability:revisions begin
    capabilities.revisions && 'revisions',
    // capability:revisions end
    // PDFs: the subject has them and the deployment has Gotenberg.
    capabilities.pdf && documentsOn && 'documents',
    related.length > 0 && 'related',
    // Absent from an older API's answer.
    // capability:merge begin
    capabilities.merge && 'duplicates',
    // capability:merge end
  ].filter(
    (
      tab,
    ): tab is
      | 'comments'
      | 'attachments'
      | 'revisions'
      | 'documents'
      | 'related'
      | 'duplicates' => !!tab,
  );

  // The tags show above the tabs, without one.
  let shown = tabs.length > 0;
  // capability:tags begin
  shown ||= !!capabilities.tags;
  // capability:tags end
  if (!shown) return null;

  return (
    <div className="flex flex-col gap-6">
      {/* capability:tags begin */}
      {capabilities.tags && (
        <section aria-labelledby="record-tags" className="flex flex-col gap-2">
          <h2 id="record-tags" className="text-sm font-medium">
            {t('panel.title', { ns: 'tags' })}
          </h2>
          <TagsPanel
            subject={props.subject}
            listPath={listPath}
            base={props.path}
            id={props.id}
            tags={props.tags ?? []}
            canEdit={canUpdate}
          />
        </section>
      )}
      {/* capability:tags end */}
      {tabs.length > 0 && (
        <Tabs defaultValue={tabs[0]}>
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {tab === 'related'
                  ? t('related.title')
                  : t('title', { ns: tab === 'duplicates' ? 'merge' : tab })}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* capability:comments begin */}
          {capabilities.comments && (
            <TabsContent value="comments" className="pt-4">
              <CommentsPanel
                base={props.path}
                id={props.id}
                canModerate={canUpdate}
              />
            </TabsContent>
          )}
          {/* capability:comments end */}
          {/* capability:attachments begin */}
          {capabilities.attachments && attachmentLimits && (
            <TabsContent value="attachments" className="pt-4">
              <AttachmentsPanel
                base={props.path}
                id={props.id}
                canWrite={canUpdate}
                limits={attachmentLimits}
              />
            </TabsContent>
          )}
          {/* capability:attachments end */}
          {/* capability:revisions begin */}
          {capabilities.revisions && (
            <TabsContent value="revisions" className="pt-4">
              <RevisionsPanel
                listPath={listPath}
                base={props.path}
                id={props.id}
                canRestore={canUpdate}
              />
            </TabsContent>
          )}
          {/* capability:revisions end */}
          {capabilities.pdf && documentsOn && (
            <TabsContent value="documents" className="pt-4">
              <DocumentsPanel base={props.path} id={props.id} />
            </TabsContent>
          )}
          {related.length > 0 && (
            <TabsContent value="related" className="flex flex-col gap-6 pt-4">
              {related.map((relation) => (
                <RelatedPanel
                  key={`${relation.path}.${relation.field}`}
                  base={props.path}
                  id={props.id}
                  related={relation}
                />
              ))}
            </TabsContent>
          )}
          {/* capability:merge begin */}
          {capabilities.merge && (
            <TabsContent value="duplicates" className="pt-4">
              <DuplicatesPanel
                base={props.path}
                id={props.id}
                listPath={listPath}
                canMerge={canUpdate}
              />
            </TabsContent>
          )}
          {/* capability:merge end */}
        </Tabs>
      )}
    </div>
  );
}

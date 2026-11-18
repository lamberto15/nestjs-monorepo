/**
 * Generated from openapi.json by `pnpm client:generate`: do not edit.
 * `pnpm client:check` fails when it is stale.
 */

import type { components } from './schema.js';

/** Every event the API pushes on `/realtime`, with its payload (the OpenAPI document's `x-realtime-events`). */
export interface RealtimeEventPayloads {
  /** An AI run you asked for failed for good; error is its code. */
  'ai.failed': components['schemas']['RealtimeAiFailedEvent'];
  /** An AI run you asked for finished: read the answer at GET /v1/ai/runs/{id}. */
  'ai.ready': components['schemas']['RealtimeAiReadyEvent'];
  /** An approved request's outcome was applied: outcomeAppliedAt is now set on GET /v1/approvals/{id}. */
  'approval.applied': components['schemas']['RealtimeApprovalAppliedEvent'];
  /** An approval request waits for you (or for someone you stand in for): GET /v1/approvals/{id}. */
  'approval.assigned': components['schemas']['RealtimeApprovalAssignedEvent'];
  /** A decision on a request you made or decide, or its end: status is the request's after it; decision is null when no person decided (cancelled, expired, failed). */
  'approval.decided': components['schemas']['RealtimeApprovalDecidedEvent'];
  /** A queued bulk run failed for good; items done stay done. error says why, for people. */
  'bulk.failed': components['schemas']['RealtimeBulkFailedEvent'];
  /** A queued bulk operation ended; its item results: GET /v1/bulk/{id}. */
  'bulk.finished': components['schemas']['RealtimeBulkFinishedEvent'];
  /** A queued bulk run is running: items processed so far, every few items. */
  'bulk.progress': components['schemas']['RealtimeBulkProgressEvent'];
  /** An export is ready: url is a signed link to the file. */
  'data.export-ready': components['schemas']['RealtimeDataExportReadyEvent'];
  /** An export or import failed for good; error says why, for people. The transfer reads failed at GET /v1/data/transfers/{id} by now. */
  'data.failed': components['schemas']['RealtimeDataFailedEvent'];
  /** An import ended: how many rows were imported and how many refused. */
  'data.import-finished': components['schemas']['RealtimeDataImportFinishedEvent'];
  /** An export or import is running: processed rows so far (an import also imported and failed). Throttled; GET /v1/data/transfers/{id} has the same numbers. */
  'data.progress': components['schemas']['RealtimeDataProgressEvent'];
  /** A document you asked for failed for good; error is its code. */
  'document.failed': components['schemas']['RealtimeDocumentFailedEvent'];
  /** A document you asked for was issued: download it at GET /v1/documents/{id}/download, or as the record's attachment. */
  'document.ready': components['schemas']['RealtimeDocumentReadyEvent'];
  /** A new notification, in the recipient's language. */
  notification: components['schemas']['RealtimeNotificationEvent'];
  /** A notification was marked read (or unread: readAt null). */
  'notification.read': components['schemas']['RealtimeNotificationReadEvent'];
  /** A notification was removed. */
  'notification.removed': components['schemas']['RealtimeNotificationRemovedEvent'];
  /** before: what the call passed (null: all of them); updated: how many changed. */
  'notifications.read-all': components['schemas']['RealtimeNotificationsReadAllEvent'];
  /** After each of the above: the badge's number. */
  'notifications.unread-count': components['schemas']['RealtimeNotificationsUnreadCountEvent'];
  /** A file on a record you watch was added, removed, scanned clean or processed (an image's thumbnail and preview): ids only. */
  'record.attachments.changed': components['schemas']['RealtimeRecordAttachmentsChangedEvent'];
  /** A comment on a record you watch (or one you wrote, for your other tabs) changed: ids only, fetch the thread. */
  'record.commented': components['schemas']['RealtimeRecordCommentedEvent'];
  /** Someone started or stopped viewing or editing a record you are viewing: ids only, fetch GET /v1/presence/{subject}/{recordId}. Advisory, never a lock. */
  'record.presence': components['schemas']['RealtimeRecordPresenceEvent'];
}

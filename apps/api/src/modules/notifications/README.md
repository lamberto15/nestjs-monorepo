# modules/notifications

How a module tells people something happened, once: stored to read later,
pushed live, mailed at once or in a digest, pushed to a browser, as each
recipient prefers. Also watching records (subscriptions) and the routes under
`/notifications`, `/devices`, `/subscriptions`.

## Declare a type, send it

```ts
// notes.notifications.ts
export const NOTE_NOTIFICATIONS = defineNotifications([
  {
    type: 'note.published',
    email: 'immediate', // the default the recipient may change: false | immediate | hourly | daily
    push: true, // web push, when WEB_PUSH_SUBJECT is set
    mandatory: false, // true: a channel on by default can't be switched off
    urgent: false, // true: push goes through quiet hours
    data: z.object({ noteId: z.uuid(), title: z.string() }), // the texts' placeholders
  },
]);

// notes.module.ts: imports: [NotificationsModule.forFeature(NOTE_NOTIFICATIONS)]
// notes/i18n/en.json: { "notifications": { "note": { "published": {
//   "label": "Note published", "title": "Note published",
//   "body": { "one": "\"{title}\" is now published.", "other": "{count} notes were published; the latest is \"{title}\"." } } } } }

// notes.service.ts, in the transaction of the change:
@Transactional()
async publish(note: Note) {
  await this.notifications.notify({
    type: 'note.published', to: note.ownerId /* or 'user:<id>', or a list (at most 500) */,
    data: { noteId: note.id, title: note.title },
    link: `/notes/${note.id}`, // a path of the web app
    key: `note.published:${note.id}`, // optional: a newer one with the key replaces the older, counted up
  });
}
```

`notify()` stores the notification and publishes `notification.stored` in the
caller's transaction (it throws outside one); a worker delivers it in the
tenant it was sent in. A type no module declared, a malformed name or a type
without `notifications.<type>.{label,title,body}` in the English catalog stops
the app at start. `collapse: true` makes every notification of the type
collapse on the type. The system principal is never notified.

## Delivery (notifications.delivery.ts)

The recipient as they are now (nothing for a deactivated user or one who left
the tenant), their preferences, the texts in their language, then: **email**
(queued under the notification's id, so a retry sends once; `hourly`/`daily`
flag the row for `NotificationDigestJob`, hourly at :05, daily at
NOTIFICATIONS_DIGEST_HOUR in the user's zone); **push** (one job per
registered browser on the `push` queue, held until the user's quiet hours end
unless `urgent`; a browser the push service says is gone is forgotten);
**realtime** after the commit (`notification`, `notification.read`,
`notifications.read-all`, `notification.removed`, `notifications.unread-count`).
Mail honours MAIL_DELIVERY; a mandatory type counts as essential mail. Every
notification mail carries RFC 8058 `List-Unsubscribe` headers (https only)
except mandatory types.

## Watching records

`SubscriptionsService`: `subscribe` (in the create's transaction),
`notifyWatchers({ subject, recordId, type, data, except })`, `watchers`,
`watching`, `forget(subject, ids)` (a purge), `erase(principal)`. Routes:
`PUT /subscriptions/{subject}/{recordId}` (needs read permission on a record
found by the subject's `@AccessRecordFinder`), `GET /subscriptions`,
`DELETE /subscriptions/{subject}/{recordId}`.

A record is watchable with `NotificationsModule.forRecord(RECORD)` in the feature's imports: `POST|DELETE /<path>/{id}/watch` (whoever may read it; a record they may not read is a 404), `?include=watching`, the creator watching from the start, and the watchers told (`record.changed`, daily mail by default) when someone else updates it; a record's repeated changes collapse into one notification, counted up. Past 20 records changed in one transaction (a bulk edit) the rest sum up into one `record.bulk-changed` per watcher. A purge forgets the watchers.

## Variables (notifications.config.ts)

NOTIFICATIONS_RETENTION_DAYS, NOTIFICATIONS_MAX_AGE_DAYS,
NOTIFICATIONS_DIGEST_HOUR, NOTIFICATIONS_TIMEZONE, MAIL_UNSUBSCRIBE_MAILTO,
WEB_PUSH_SUBJECT (turns web push on), WEB_PUSH_PUBLIC_KEY /
WEB_PUSH_PRIVATE_KEY (else made once and kept in `core/secrets`),
WEB_PUSH_DEVICE_RETENTION_DAYS. Outside production `POST /notifications/test`
sends the caller a `notification.test` notification.

Remove: delete this folder and its line in `app.module.ts` (and the modules
that call `notify()`).

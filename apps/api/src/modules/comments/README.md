# modules/comments

Comments on a record: threads (one level of replies), edits, resolving a
thread, `@` mentions, and a tell to the people involved. An add-on of
[modules/records](../records/README.md): `CommentsModule.forRecord(NOTE)` in
the feature module's imports is the only switch.

```ts
@Module({ imports: [RecordsModule.forFeature(NOTE, …), CommentsModule.forRecord(NOTE)] })
```

## Routes (under the record's path)

| Route                                            | Does                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/<path>/{id}/comments`                   | oldest first, cursor pages; `?sort=-createdAt`, `?author=`, `?createdAt.gte=`, `?parentId=<id>` (one thread's replies), `?parentId.isNull=true` (the threads), `?resolvedAt.isNull=true` (open) |
| `POST …/comments { body, parentId? }`            | 201; 1 to 10 000 characters; `parentId` answers a top-level comment                                                                                                                             |
| `PATCH …/comments/{commentId} { body }`          | the author only; sets `editedAt`                                                                                                                                                                |
| `DELETE …/comments/{commentId}`                  | the author, or whoever may `update` the record; for good, a thread's replies with it                                                                                                            |
| `POST …/comments/{commentId}/resolve`, `/reopen` | the thread's author, or whoever may `update` the record                                                                                                                                         |

Whoever may read the record reads and writes its comments; for anyone else it
is the 404 of a missing record. Errors: 400 `comment_reply_too_deep`,
`comment_not_thread`; 409 `comment_thread_resolved`, `comment_thread_full`
(200 replies).

## Mentions and notifications

`@ada@example.com` or `@user:<id>` in the body: only active members of the
tenant who may read the record are kept in `mentions` (anyone else is dropped
silently, so a mention never tells who exists) and get `comment.mentioned`. A
reply tells the thread's author (`comment.replied`); the record's watchers
(modules/notifications, `SubscriptionsService`), but the author, those
mentioned and the thread's author, get `comment.added`, collapsed per record.
The author watches the record from their first comment on it. Each comment
carries `authorName` and `mentionNames` (a member who left keeps their name).
After each write `record.commented` (`{ subject, recordId, commentId, action }`)
goes over realtime to the watchers and the author who may read the record.
Audit: `comment.added|edited|removed|resolved|reopened` (never the text).

## What it adds to the record

`capabilities.comments` in `GET /v1/lists/{subject}`; its comments are
deleted with the record when it is deleted for good (`purged`). Table
`comments` (`comments.tables.ts`); no variables. Needs QueuesModule, the
notifications' and realtime's requirements, and the record's module.

Remove: delete this folder and the `forRecord()` imports of the features.

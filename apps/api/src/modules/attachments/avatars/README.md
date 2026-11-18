# modules/attachments/avatars

A user's picture. Not a record's add-on: `AvatarsModule` is listed in
`app.module.ts` beside `AttachmentsModule`. Needs StorageModule.

| Route                                              | Does                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PUT /v1/account/avatar` (multipart, field `file`) | 200 `{ avatarUrl }`; users only, never while impersonating                                                                  |
| `DELETE /v1/account/avatar`                        | 204; the file goes too                                                                                                      |
| `GET /v1/people/{id}/avatar`                       | the image (inline, `private, max-age=300`), streamed by the API; the person, or a member of the tenant you act in; else 404 |

Stored at `accounts/<user id>/avatar/<random>.<ext>` (the picture is the
person's, not a tenant's), its key in `user_avatars`; the change and its audit
entry (`account.avatar-changed`, `account.avatar-removed`) commit together.
PNG, JPEG, WebP, GIF by their bytes (415), at most AVATAR_MAX_MB (413). Stored
as uploaded. `AvatarsService.urlOf(userId)` and `avatarUrl()` give the
`/v1/people/<id>/avatar?v=…` path a module that lists people shows.

Variable (`avatars.config.ts`): AVATAR_MAX_MB (2).

Remove: delete this folder and its line in `app.module.ts`.

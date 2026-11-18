# modules/views

Saved views: a list's filters, sort and columns kept under a name, for every list `GET /v1/lists/{subject}` describes (each record's, and the users').

- **Routes** (`/v1/views`, anyone signed in): `GET` (the views you see: yours, your units', the tenant's, of the lists you may read; `?subject=`, `?visibility=`, `?name.contains=`), `POST`, `GET|PATCH|DELETE /{id}`, `GET /{id}/apply` (the query to send to the list route, and the columns you may see).
- **Visibility:** `private` (default), `unit` (a unit you belong to) or `tenant` (`Access.manageViews`, which also lets a manager change or delete shared views). A name is unique per list and place, whatever its case; at most 100 views per owner.
- **Checks:** a view is validated against the list as it is now when saved and when applied (a 400 `query.<parameter>` or `columns`), then against the viewer's field permissions (403 `field_forbidden` for a filter, sort or search on a field they may not read; a column they may not see is left out).
- **Use:** list `ViewsModule` in `app.module.ts`. No record opts in: every list the lists module describes takes views.
- **Tables:** `saved_views`. Audit: `view.created|updated|deleted`.

Remove: delete this folder and its line in `app.module.ts`.

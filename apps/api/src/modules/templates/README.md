# modules/templates

Record templates: values that prefill a create, kept under a name. A template creates nothing and bypasses nothing: the client previews it, then creates the record through the record's own route.

- **Opt in:** a feature imports `TemplatesModule.forRecord(DECLARATION)`; its list description says `capabilities.templates`. The import also brings the routes.
- **Routes** (`/v1/templates`, anyone signed in): `GET /subjects` (the records you may create, with the create fields you may set), `GET`, `POST`, `GET|PATCH|DELETE /{id}`, `GET /{id}/preview` (`values` that still hold, `dropped` those the create schema or your permissions no longer allow).
- **Visibility:** `private`, `unit` or `tenant` (`Access.manageTemplates`), as saved views. Values are checked against the record's create fields (`fieldSchemas()`) and the saver's field permissions; read-only fields are not create fields. Body keys an add-on contributes (`namingSeriesId`, custom fields) are not held.
- **Tables:** `record_templates`. Audit: `recordTemplate.created|updated|deleted`.

Remove: delete this folder and the `forRecord()` imports.

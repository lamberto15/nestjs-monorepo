# modules/forms

Forms administrators build at runtime (an intake, a questionnaire, a
checklist) and people fill in, without a migration or a deploy. A form is
data, never code: sections of typed fields, checked on the server when it is
saved, published as immutable versions, and answered. Off per tenant until
`forms.enabled` is on. A leaf module: nothing imports it.

## Permissions

The subject `Form` has four rights, none implying another: `read` (published
forms and their versions), `submit` (fill them in, read one's own
submissions), `edit` (create, edit drafts, publish, archive, public links),
`readResponses` (everyone's submissions). Administrators hold all four. An
operator reading through a break-glass grant holds every read action, but
never `readResponses`: answers are a person's (`forms.policy.ts`).

## Definitions

A definition is `{ format, sections[] }`; a section
`{ key, title?, description?, visibleWhen?, startsPage?, fields[] }`; a field
`{ key, type, label, help?, placeholder?, required?, default?, options?, optionsSource?, validation?, visibleWhen?, requiredWhen?, fields?, translations? }`
(`form-definition.ts`). Types: `text`, `textarea`, `email`, `url`,
`integer`, `decimal`, `date`, `checkbox`, `select`, `multiSelect`, `radio`,
`group`. Keys, text limits, RE2 patterns, email and http(s) checks are custom
fields' own (`modules/custom-fields`, `custom-field.values.ts`).

- **Formats:** 1 fields; 2 conditions; 3 pages (`startsPage`) and repeatable
  groups (one level, at most 50 items); 4 option sources. What a later format adds is refused in an
  earlier one; a definition sent without `format` takes the latest.
- **Conditions** (`form-rules.ts`): `{ field, op, value }`, `all`, `any`,
  `not`, reading only fields before them (no cycle), at most 4 deep and 20
  predicates. A hidden field's answer is stripped, never required.
- **Limits:** 50 sections, 200 fields, 200 options, 20 fields a group,
  10 translations, 64 KiB as JSON. Problems answer 400 at their path
  (`definition.sections.0.fields.2.options`).
- **Versions are immutable;** once published a key keeps its type
  (`keyTypes`). Every draft save and publish sends the `revision` it edited:
  a stale one is 409 `form_conflict`.

## Routes

```text
GET    /v1/forms                          editors all, others the published active ones
POST   /v1/forms                          { slug, name, description?, definition? }
GET    /v1/forms/{id}
PATCH  /v1/forms/{id}                     slug, name, description
DELETE /v1/forms/{id}                     only a form never published (409 form_published)
GET    /v1/forms/{id}/draft
PUT    /v1/forms/{id}/draft               { revision, definition }
POST   /v1/forms/{id}/publish             { revision }
POST   /v1/forms/{id}/archive | unarchive
GET    /v1/forms/{id}/published           what a renderer shows and submits
GET    /v1/forms/{id}/versions[/{version}]
GET    /v1/forms/option-sources           the providers an editor may name (Form.edit)
GET    /v1/forms/{id}/options/{key}       ?q=&limit=: a published field's choices
POST   /v1/forms/{id}/submissions         { versionId, answers }, Idempotency-Key required, 30 a minute per user
GET    /v1/forms/{id}/submissions[/{sid}] everyone's with readResponses, one's own with submit
POST   /v1/forms/{id}/public-links        { expiresAt?, maxSubmissions? }: the token, shown once
GET    /v1/forms/{id}/public-links
POST   /v1/forms/{id}/public-links/{linkId}/revoke
POST   /v1/public/forms/open              { token }: no sign-in, 30 a minute per address
POST   /v1/public/forms/submit            { token, versionId, answers }: no sign-in, 10 in 10 minutes per address, bot protection
```

## Submissions

Answers are checked against the version they name (`form-answers.ts`):
unknown keys, wrong types, values out of range or not among the options, and
missing required answers are refused at `answers.<key>`; defaults fill what
is left out; values are normalized (`"3"` is 3). At most 64 KiB. Answers to a
version no longer published are 409 `form_version_outdated`. Audited
`form.submitted` with the form, version and submitter, never the answers.
Answers are not encrypted at rest: don't collect secrets in a form.

## Public forms

Only a member with `Form.edit` makes a link (an API client gets 403), at most
5 working per form, until `expiresAt` (30 days by default, 365 at most), its
revocation or its `maxSubmissions` (1000 by default). The token is
`frm_<tenant id>_<32 random bytes>`, kept as a SHA-256 hash: the tenant comes
from the token, never from the caller. Every refusal (forged, another
tenant's, expired, revoked, used up, archived or unpublished form, forms off)
is the same 404 `form_link_not_found`. A link opens the published version's
name, description and definition, nothing else; a submission is stored as
`public:<link id>`, audited by `anonymous`, its quota taken in the
submission's transaction. `submit` asks for a challenge (iam/captcha, action
`public-form`). The web page is `<WEB_URL>/public-form#<token>`.

## Elsewhere

- **Settings:** `forms.enabled` (modules/settings), public.
- **Retention:** rule `form-submission` (purge, 730 days by default,
  30 at least), off until a tenant turns it on (modules/retention).
- **Personal data:** section `form-submissions` (iam/personal-data): a
  person's submissions in their export, deleted with their account.
- **Tables:** `forms`, `form_versions`, `form_submissions`,
  `form_public_links`, tenant tables.

## Option sources

A choice field (`select`, `radio`, `multiSelect`) takes its choices from a
provider of modules/choices (`@ChoiceSource()`, trusted code, never a URL or
a query) in place of `options`: `"optionsSource": { "provider": "organizational-units" }`
(`form-option-sources.service.ts`).

- At save and publish the provider must be registered, take no parameters
  and be usable by the editor; a sourced field takes no `options`, no
  `default`, and its conditions only `isEmpty`. A group's fields take none.
- Choices are read through the form's published field, never by provider
  name: `limit` 20 by default, at most 50, `hasMore`, `q` up to 100
  characters. 403 `form_source_forbidden` when the provider refuses the
  caller; each call has 5 seconds, then 503 `form_source_unavailable`.
- Each answer is checked with the provider's `has` for the sender (a
  sourced multiSelect holds at most 50 values); the value is stored, never
  the label.
- Never public: a link is refused for a sourced version (400
  `form_link_sources`), and a link made earlier answers 404 once one is
  published.

Forms have no file field.

## Variables

None.

Remove: delete this folder and its line in `app.module.ts`, then a migration
dropping its tables.

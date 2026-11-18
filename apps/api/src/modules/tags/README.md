# Tags

Labels on records. Administrators define tags per record subject; people who
may change a record set its tags. A record shows its `tags`, and its list
filters by them. A record add-on (records README, "Writing an add-on").

## Routes

| Route                      | Does                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/tags`             | Any signed-in principal: the tags, newest first; `?subject=`, `?name=` (any case), `?name.contains=`, `?sort=name`; each with `usageCount`                     |
| `POST /v1/tags`            | `Access.manageTags`: `{ subject, name, color?, description? }`; 409 `tag_taken` (a name is unique per subject, any case); 400 for a subject that takes no tags |
| `PATCH /v1/tags/{id}`      | `Access.manageTags`: rename, recolour (`#rrggbb`), describe; null clears                                                                                       |
| `DELETE /v1/tags/{id}`     | `Access.manageTags`: every record loses the tag                                                                                                                |
| `PUT /v1/<path>/{id}/tags` | Whoever may update the record: `{ tagIds }` replaces its set; answers `{ items }`; 400 names each id (`tagIds.1`) that is not a tag of the subject             |

Tag changes are audited (`tag.created|updated|deleted`); a record's set as
`tags.changed` (from, to, added, removed), only when it changed.

## On a record

`TagsModule.forRecord(RECORD)` in the feature module's imports, and the
response shape in its schemas: `recordSchemas(RECORD, { response: TAGS_RESPONSE })`.
It adds `tags` to the record (in its ETag: it changes only in the
`PUT`), `?tag=<id>` and `?tag.in=<id>,<id>` to its list, `capabilities.tags`
to its description, and removes the links of records deleted for good.
Tags have their own table (`tags`, `record_tags`): the record's table is not touched.

## Other modules

`TagsModule` exports `TagsService` (`tagsOf(subject, ids)`, `setTags()`) and
`TagsRegistry`. The `/v1/tags` routes load with the first `forRecord()`.

`AddTagAction` is the `addTag` action of modules/automations (`{ tagId }`: a
tag of the subject; it needs `update` on the record and keeps the tags it
has), declared here with `@AutomationAction`, so the automations never import
tags. Only subjects that take tags have it.

Tests: `tags.e2e-spec.ts`, on the fixture's test items.

# modules/features

`GET /v1/features`: which switches this deployment has on, for a client that
hides what is off. No list names them: a module reports its own with a provider
marked `@Feature({ name: zodSchema })` (`core/http/feature.ts`) whose `value()` reads the switch the way
the module reads it, so the answer cannot disagree with its routes; an on/off
variable a route checks with `@RequiresSwitch()` is `switchFeature(name,
description, path)`. The OpenAPI document has every declared name as a key,
with its schema, so the typed client knows them. A tenant's feature flags are
settings (`modules/settings`), not this.

Remove: `pnpm module:remove features` ([removing-a-module](../../../../../docs/removing-a-module.md)).

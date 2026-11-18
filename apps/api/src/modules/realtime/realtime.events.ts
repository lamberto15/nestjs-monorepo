import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { openApiAdditions } from '../../core/http/openapi.js';

/**
 * A live event a module pushes to sockets: its name (what the client listens
 * for) and the schema of its payload. The module that pushes it declares it,
 * next to the code: `export const thumbnailReady = defineRealtimeEvent('thumbnail.ready', z.object({ fileKey: z.string() }))`.
 * Payloads carry ids and small facts, never content: the client fetches the
 * rest with its own permissions. Defining an event also publishes it in the
 * OpenAPI document (`x-realtime-events`, below), so it must be defined at
 * import time, never inside a provider.
 */
export interface RealtimeEvent<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly payload: S;
  /** What the typed client's documentation says of it. */
  readonly description: string;
}

/** Every event defined in this process, by name: what the OpenAPI document lists. */
const declared = new Map<string, RealtimeEvent>();

const EVENT_NAME = /^[a-z][\w-]*(\.[\w-]+)*$/;

export function defineRealtimeEvent<S extends z.ZodType>(
  name: string,
  payload: S,
  description = `The realtime event "${name}".`,
): RealtimeEvent<S> {
  if (!EVENT_NAME.test(name)) {
    throw new TypeError(
      `"${name}" is not a realtime event name: lowercase, full-stop delimited, as in thumbnail.ready.`,
    );
  }
  const event = { name, payload, description };
  declared.set(name, event);
  return event;
}

/** `thumbnail.ready` becomes the payload's component, `RealtimeThumbnailReadyEvent`. */
const componentId = (name: string) =>
  `Realtime${name
    .split(/[.-]/)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')}Event`;

/**
 * Publishes the declared events in the OpenAPI document: each payload as a
 * component and `x-realtime-events`, a map of event name to
 * `{ description, payload: $ref }`, which the typed client's generator
 * turns into `RealtimeEventPayloads`. Added through core/http's
 * `openApiAdditions`, so it is in `/api-json` and in `openapi-dump`.
 */
export function addRealtimeEvents(document: OpenAPIObject) {
  const schemas = ((document.components ??= {}).schemas ??= {});
  const manifest: Record<string, { description: string; payload: object }> = {};
  for (const event of [...declared.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const {
      $schema: _,
      $defs,
      definitions,
      ...schema
    } = z.toJSONSchema(event.payload, {
      target: 'openapi-3.0',
      io: 'output',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    const point = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('"#/$defs/', '"#/components/schemas/')
          .replaceAll('"#/definitions/', '"#/components/schemas/'),
      ) as (typeof schemas)[string];
    const named = (definitions ?? $defs ?? {}) as Record<string, unknown>;
    for (const [id, definition] of Object.entries(named)) {
      schemas[id] ??= point(definition);
    }
    const id = componentId(event.name);
    schemas[id] = point(schema);
    manifest[event.name] = {
      description: event.description,
      payload: { $ref: `#/components/schemas/${id}` },
    };
  }
  (document as unknown as Record<string, unknown>)['x-realtime-events'] =
    manifest;
}

// At import: `openapi-dump` instantiates nothing, and every module that
// pushes an event imports this file.
openApiAdditions.document.set('realtime', addRealtimeEvents);

/** The problem with a payload, or undefined when it fits the event's schema. */
export function payloadProblem(event: RealtimeEvent, data: unknown) {
  const result = event.payload.safeParse(data);
  return result.success
    ? undefined
    : `Realtime event "${event.name}" payload: ${z.prettifyError(result.error)}`;
}

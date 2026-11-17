import { z } from 'zod';

/**
 * A live event a module pushes to sockets: its name (what the client listens
 * for) and the schema of its payload. The module that pushes it declares it,
 * next to the code: `export const thumbnailReady = defineRealtimeEvent('thumbnail.ready', z.object({ fileKey: z.string() }))`.
 * Payloads carry ids and small facts, never content: the client fetches the
 * rest with its own permissions.
 */
export interface RealtimeEvent<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly payload: S;
}

const EVENT_NAME = /^[a-z][\w-]*(\.[\w-]+)*$/;

export function defineRealtimeEvent<S extends z.ZodType>(
  name: string,
  payload: S,
): RealtimeEvent<S> {
  if (!EVENT_NAME.test(name)) {
    throw new TypeError(
      `"${name}" is not a realtime event name: lowercase, full-stop delimited, as in thumbnail.ready.`,
    );
  }
  return { name, payload };
}

/** The problem with a payload, or undefined when it fits the event's schema. */
export function payloadProblem(event: RealtimeEvent, data: unknown) {
  const result = event.payload.safeParse(data);
  return result.success
    ? undefined
    : `Realtime event "${event.name}" payload: ${z.prettifyError(result.error)}`;
}

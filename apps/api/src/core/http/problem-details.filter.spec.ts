import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ProblemDetailsFilter,
  validationException,
} from './problem-details.filter.js';

describe('ProblemDetailsFilter', () => {
  beforeAll(() => Logger.overrideLogger(false));

  /** Runs the filter on `exception` for an HTTP request; returns what it answered. */
  function answer(exception: unknown, request?: Record<string, unknown>) {
    const req = request ?? {
      originalUrl: '/v1/things?secret=1',
      headers: { 'x-request-id': 'req-unit-0001' },
    };
    const replies: { body: Record<string, unknown>; status: number }[] = [];
    const headers: Record<string, string> = {};
    const filter = new ProblemDetailsFilter({
      httpAdapter: {
        setHeader: (_res: unknown, name: string, value: string) =>
          (headers[name] = value),
        reply: (_res: unknown, body: Record<string, unknown>, status: number) =>
          replies.push({ body, status }),
      },
    } as never);
    filter.catch(exception, {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
    } as never);
    expect(headers['Content-Type']).toBe(
      'application/problem+json; charset=utf-8',
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].status).toBe(replies[0].body.status);
    return replies[0].body;
  }

  it('answers a 503 that says when to come back with Retry-After', () => {
    const headers: Record<string, string> = {};
    const filter = new ProblemDetailsFilter({
      httpAdapter: {
        setHeader: (_res: unknown, name: string, value: string) =>
          (headers[name] = value),
        reply: () => undefined,
      },
    } as never);
    filter.catch(
      new ServiceUnavailableException({ code: 'busy', retryAfter: 1 }),
      {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({ url: '/v1/things', headers: {} }),
          getResponse: () => ({}),
        }),
      } as never,
    );
    expect(headers['Retry-After']).toBe('1');
  });

  it('keeps a 503 whose body has a `status` of its own (GET /health when PostgreSQL or Redis is down)', () => {
    // What @nestjs/terminus throws: its `status: 'error'` once replaced the
    // 503, and Express answered 500; its failing indicators were dropped.
    const down = new ServiceUnavailableException({
      status: 'error',
      info: { database: { status: 'up' } },
      error: { redis: { status: 'down', message: 'timeout' } },
      details: {
        database: { status: 'up' },
        redis: { status: 'down', message: 'timeout' },
      },
    });
    const body = answer(down);
    expect(body).toMatchObject({
      status: 503,
      code: 'unavailable',
      error: { redis: { status: 'down', message: 'timeout' } },
      details: { redis: { status: 'down' } },
    });
    // Nest's own `error` (the status's name) stays out: `title` says it.
    expect(answer(new ConflictException('Taken')).error).toBeUndefined();
  });

  it('never shows the internals of an unexpected error', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432 (user=app)');
    const body = answer(error);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Something went wrong on our side.',
      code: 'internal_error',
      instance: '/v1/things',
      requestId: 'req-unit-0001',
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    // Not even when what was thrown isn't an Error.
    expect(answer('a string').status).toBe(500);
    expect(answer(undefined).status).toBe(500);
    expect(answer({ message: 'leak', status: 418 }).detail).toBe(
      'Something went wrong on our side.',
    );
  });

  it('keeps the code and extensions an exception carries', () => {
    expect(
      answer(
        new ConflictException({
          code: 'note_published',
          message: 'Published notes are final.',
          noteId: 'n1',
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'note_published',
      detail: 'Published notes are final.',
      noteId: 'n1',
    });
    // A package's `errorCode` serves as the code.
    expect(
      answer(new HttpException({ errorCode: 'E_X', message: 'm' }, 422)).code,
    ).toBe('E_X');
    // A string body is the detail; the status names the code.
    expect(answer(new HttpException('Teapot', 418))).toMatchObject({
      detail: 'Teapot',
      code: 'http_418',
      title: "I'm a Teapot",
    });
    expect(answer(new HttpException('Gone', HttpStatus.GONE)).code).toBe(
      'gone',
    );
  });

  it("turns Nest's list of messages into field errors", () => {
    expect(
      answer(new BadRequestException(['a is bad', 'b is bad'])),
    ).toMatchObject({
      detail: 'Bad Request',
      errors: [
        { path: '', message: 'a is bad' },
        { path: '', message: 'b is bad' },
      ],
    });
  });

  it('gives each validation issue its dotted path, array indexes and keys included', () => {
    const body = answer(
      validationException([
        { message: 'm1', path: ['items', 0, 'quantity'] },
        {
          message: 'm2',
          path: [{ key: 'address' }, { key: 'lines' }, { key: 2 }],
        },
        { message: 'm3' },
      ]),
    );
    expect(body.errors).toEqual([
      { path: 'items.0.quantity', message: 'm1' },
      { path: 'address.lines.2', message: 'm2' },
      { path: '', message: 'm3' },
    ]);
    expect(body.code).toBe('validation_failed');
  });

  it('maps a registered error type, and leaves others as a 500', () => {
    class OutOfStock extends Error {}
    class Unmapped extends Error {}
    ProblemDetailsFilter.map(
      OutOfStock,
      (error) =>
        new ConflictException({ code: 'out_of_stock', message: error.message }),
    );
    expect(answer(new OutOfStock('No more cats.'))).toMatchObject({
      status: 409,
      code: 'out_of_stock',
      detail: 'No more cats.',
    });
    expect(answer(new Unmapped('internal')).status).toBe(500);
  });

  it('answers a unique violation no service mapped as a 409 conflict', () => {
    // Drizzle wraps the driver's error; the SQLSTATE is in its cause.
    const error = new Error('Failed query', {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    expect(answer(error)).toMatchObject({ status: 409, code: 'conflict' });
  });

  it('answers a value the database could not read as a 400 invalid_value', () => {
    const error = new Error('Failed query', {
      cause: Object.assign(new Error('invalid input syntax for type uuid'), {
        code: '22P02',
      }),
    });
    expect(answer(error)).toMatchObject({ status: 400, code: 'invalid_value' });
  });
});

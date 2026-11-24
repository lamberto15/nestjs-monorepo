import { HttpCode, Post, Get, Logger, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { lastValueFrom, of } from 'rxjs';
import { z } from 'zod';
import { ResponseSchemaInterceptor } from './response-schema.interceptor.js';

const note = z.object({ id: z.string(), createdAt: z.iso.datetime() });

class NotesController {
  @Get()
  @ApiOkResponse({ standardSchema: note })
  one() {}

  @Get()
  @ApiOkResponse({ standardSchema: z.array(note) })
  many() {}

  @Post()
  @ApiCreatedResponse({ standardSchema: note })
  create() {}

  @Post()
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: note })
  act() {}

  @Get()
  undocumented() {}

  @Post()
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: note })
  @ApiAcceptedResponse({ standardSchema: z.object({ jobId: z.string() }) })
  maybeQueued() {}
}

describe('ResponseSchemaInterceptor', () => {
  beforeAll(() => Logger.overrideLogger(false));
  const interceptor = new ResponseSchemaInterceptor(new Reflector());

  const respond = (
    handler: keyof NotesController,
    body: unknown,
    { query = {}, statusCode = 200 } = {},
  ) =>
    lastValueFrom(
      interceptor.intercept(
        {
          getType: () => 'http',
          getClass: () => NotesController,
          getHandler: () => NotesController.prototype[handler],
          switchToHttp: () => ({
            getRequest: () => ({ query }),
            getResponse: () => ({ statusCode }),
          }),
        } as never,
        { handle: () => of(body) },
      ),
    );

  const at = new Date('2026-11-25T10:00:00.000Z');

  it('sends what the documented schema declares, dates as on the wire', async () => {
    await expect(
      respond('one', { id: 'n1', createdAt: at, tenantId: 't1' }),
    ).resolves.toEqual({ id: 'n1', createdAt: '2026-11-25T10:00:00.000Z' });
  });

  it("uses the schema of the route's status, an array as a whole", async () => {
    await expect(
      respond('create', { id: 'n1', createdAt: at, x: 1 }),
    ).resolves.toEqual({
      id: 'n1',
      createdAt: at.toISOString(),
    });
    await expect(
      respond('act', { id: 'n1', createdAt: at, x: 1 }),
    ).resolves.not.toHaveProperty('x');
    await expect(
      respond('many', [{ id: 'n1', createdAt: at, x: 1 }]),
    ).resolves.toEqual([{ id: 'n1', createdAt: at.toISOString() }]);
  });

  it('fails a response off its schema', async () => {
    await expect(respond('one', { id: 1, createdAt: at })).rejects.toThrow(
      /NotesController\.one off its documented schema: id:/,
    );
  });

  it('passes what has no schema, and what is not JSON', async () => {
    await expect(respond('undocumented', { secret: 1 })).resolves.toEqual({
      secret: 1,
    });
    const file = new StreamableFile(Buffer.from('x'));
    await expect(respond('one', file)).resolves.toBe(file);
    await expect(respond('one', undefined)).resolves.toBeUndefined();
  });

  it('answers the schema of the status a handler set itself', async () => {
    await expect(
      respond('maybeQueued', { jobId: 'j1', x: 1 }, { statusCode: 202 }),
    ).resolves.toEqual({ jobId: 'j1' });
  });

  it('leaves a response narrowed by fields or widened by include as it is', async () => {
    await expect(
      respond('one', { id: 'n1' }, { query: { fields: 'id' } }),
    ).resolves.toEqual({ id: 'n1' });
    await expect(
      respond(
        'one',
        { id: 'n1', createdAt: at, can: {} },
        { query: { include: 'can' } },
      ),
    ).resolves.toHaveProperty('can');
  });
});

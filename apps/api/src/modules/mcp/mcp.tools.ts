import { ForbiddenException, Injectable } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { t } from '@nestjs/i18n';
import { Tool } from '@nestjs/mcp';
import { z } from 'zod';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { ListsService } from '../lists/lists.service.js';
import { SearchService } from '../search/search.service.js';
import { McpTools } from './mcp-tools.js';

const describeListInput = z.object({
  subject: z
    .string()
    .min(1)
    .max(100)
    .describe('The kind of record, as permissions name it: TestItem, User.'),
});

/** GET /v1/search's query, as arguments. */
const searchInput = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'Words match anywhere; "quoted words" as a phrase; -word excludes; or between words.',
    ),
  subject: z
    .string()
    .max(100)
    .optional()
    .describe('Only this kind of record (TestItem); default: every kind.'),
  limit: z.number().int().min(1).max(50).default(20),
});

/**
 * Tools of the app as a whole, each one call of the module that owns it:
 * who the caller is, how a list may be queried, the global search. A record's own tools
 * come with `McpModule.forRecord()`.
 */
@McpTools()
@Injectable()
export class McpAppTools {
  constructor(
    private readonly access: AccessService,
    private readonly lists: ListsService,
    private readonly searches: SearchService,
  ) {}

  @Tool({
    name: 'whoami',
    title: 'Who am I',
    description:
      'Who you act as (a user or an API client), the tenant you act in, and your permissions: each subject and action you hold, with its conditions (mine: only your own records). Call it first to learn what you may do.',
    annotations: { readOnlyHint: true },
  })
  @Can.Anyone() // The caller's own principal.
  async whoami(
    _input: unknown,
    _context: unknown,
    @CurrentUser() user: RequestPrincipal,
  ) {
    return {
      principal:
        user.kind === 'user'
          ? { kind: user.kind, id: user.id, email: user.email, name: user.name }
          : { kind: user.kind, id: user.id, name: user.name },
      tenantId: user.tenantId,
      permissions: await this.access.permissions(user),
    };
  }

  @Tool({
    name: 'describe_list',
    title: 'Describe a list',
    description:
      "How a kind of record's list may be queried: its fields, the filters and operators each takes, the sorts, whether it searches (q), and the views. The <path>_list tool takes these as its arguments. Fields your permissions hide are left out.",
    inputSchema: describeListInput,
    annotations: { readOnlyHint: true },
  })
  @Can.Anyone() // Checked below, on the subject (as GET /v1/lists/{subject}).
  async describeList(
    { subject }: z.infer<typeof describeListInput>,
    _context: unknown,
    @CurrentUser() user: RequestPrincipal,
  ) {
    // An unknown subject is a 404 before any permission is asked.
    this.lists.source(subject);
    if (!(await this.lists.mayRead(user, subject))) {
      throw new ForbiddenException(t('mcp.listForbidden'));
    }
    return this.lists.describe(user, subject);
  }

  @Tool({
    name: 'search',
    title: 'Search',
    description:
      'Searches every kind of record you may read, as GET /v1/search: best matches first, across kinds, each hit its subject and id (the <path>_get tool reads it), a title and a snippet with the matches in <b>…</b>.',
    inputSchema: searchInput,
    annotations: { readOnlyHint: true },
  })
  @Can.Anyone() // Each record filters by what the caller may read.
  async search(
    { q, subject, limit }: z.infer<typeof searchInput>,
    _context: unknown,
    @CurrentUser() user: RequestPrincipal,
  ) {
    return { items: await this.searches.search(user, q, { subject, limit }) };
  }
}

import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import { RecordController } from '../records/record-extension.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import { COMMENT_LIST } from './comments.lists.js';
import {
  type CommentBody,
  commentBodySchema,
  type CommentCreate,
  commentCreateSchema,
  commentPageSchema,
  commentSchema,
} from './comments.schemas.js';
import { CommentsService } from './comments.service.js';

/**
 * `/<path>/{id}/comments`: a record's comments. Whoever may read the record
 * reads and writes them (CommentsService looks the record up as the caller);
 * `@<email>` mentions a person who may read it too.
 */
export function commentsController(record: RecordDeclaration): Type {
  const noun = record.noun;
  const subject = record.subject;

  @ApiForbiddenResponse({ description: `You may not change this comment.` })
  @ApiNotFoundResponse({ description: `No such ${noun} (or comment).` })
  @RecordController(record, ':id/comments', 'Comments')
  class CommentRoutes {
    constructor(private readonly comments: CommentsService) {}

    @Get()
    @Can.Anyone() // Checked by CommentsService: reading the record.
    @ApiOperation({
      summary: `${aNoun(record)}'s comments, oldest first`,
      description:
        "Cursor pages, replies included (each has `parentId`); `?sort=-createdAt` for newest first, `?author=user:<id>`, `?createdAt.gte=`, `?parentId=<comment id>` (one thread's replies) or `?parentId.isNull=true` (the threads), `?resolvedAt.isNull=true` (open) or `=false` (resolved).",
    })
    @ApiOkResponse({ standardSchema: commentPageSchema })
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: COMMENT_LIST.schema }) query: ListQuery,
    ) {
      return COMMENT_LIST.pick(
        await this.comments.list(user, id, query),
        query,
      );
    }

    @Post()
    @Can.Anyone()
    @ApiOperation({
      summary: `Comment on ${aNoun(record)}`,
      description: `Mention people with \`@<email>\` or \`@user:<id>\`: those who may read the ${noun} are told (\`comment.mentioned\`); its watchers hear \`comment.added\`. Your first comment makes you watch it. \`parentId\` answers a top-level comment (one level of replies; its author is told, \`comment.replied\`). Audited.`,
    })
    @ApiCreatedResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description:
        'An empty body, or longer than 10 000 characters; or `parentId` is itself a reply (comment_reply_too_deep).',
    })
    @ApiConflictResponse({
      description:
        'The thread is resolved (comment_thread_resolved) or holds 200 replies (comment_thread_full).',
    })
    add(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: commentCreateSchema }) dto: CommentCreate,
      @Ip() ip: string,
    ) {
      return this.comments.add(user, id, dto.body, dto.parentId, ip);
    }

    @Post(':commentId/resolve')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Resolve a thread',
      description: `The thread's author, or whoever may change the ${noun} (\`${subject}.update\`). Sets \`resolvedAt\`/\`resolvedBy\` on the top-level comment; repeating it changes nothing. Audited (\`comment.resolved\`).`,
    })
    @ApiOkResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description: 'A reply, not a thread (comment_not_thread).',
    })
    resolve(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      return this.comments.resolve(user, id, commentId, ip);
    }

    @Post(':commentId/reopen')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Reopen a resolved thread',
      description: 'As resolving it. Audited (`comment.reopened`).',
    })
    @ApiOkResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description: 'A reply, not a thread (comment_not_thread).',
    })
    reopen(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      return this.comments.reopen(user, id, commentId, ip);
    }

    @Patch(':commentId')
    @Can.Anyone()
    @ApiOperation({
      summary: 'Change your comment',
      description:
        'Only its author; sets `editedAt`. People newly mentioned are told. Audited.',
    })
    @ApiOkResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description: 'An empty body, or longer than 10 000 characters.',
    })
    edit(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Body({ schema: commentBodySchema }) dto: CommentBody,
      @Ip() ip: string,
    ) {
      return this.comments.edit(user, id, commentId, dto.body, ip);
    }

    @Delete(':commentId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Remove a comment',
      description: `Its author, or whoever may change the ${noun} (\`${subject}.update\`). For good; audited. Removing a thread's top-level comment removes its replies too.`,
    })
    @ApiNoContentResponse()
    async remove(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      await this.comments.remove(user, id, commentId, ip);
    }
  }
  return CommentRoutes;
}

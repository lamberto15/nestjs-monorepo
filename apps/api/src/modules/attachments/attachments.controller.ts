import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  type Type,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { NodeRequest } from '@nestjs/platform-node';
import type { StoredUpload } from '@nestjs/storage';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiPreconditionFailedResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { Etag, ifMatchHeader } from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import { RecordController } from '../records/record-extension.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import { ATTACHMENT_LIST } from './attachments.lists.js';
import {
  type AttachmentAnnounce,
  attachmentAnnounceSchema,
  attachmentCompleteSchema,
  attachmentPageSchema,
  attachmentRestoreSchema,
  attachmentSchema,
  attachmentUploadSchema,
  attachmentVersionListSchema,
  attachmentVersionNoteSchema,
  type DownloadQuery,
  downloadQuerySchema,
  presignedUploadSchema,
  uploadChunkQuerySchema,
  uploadSessionSchema,
} from './attachments.schemas.js';
import {
  AttachmentsService,
  DOWNLOAD_LINK_TTL,
} from './attachments.service.js';
import { attachmentUpload } from './attachments.upload.js';
import { AttachmentUploadsService } from './attachments.uploads.js';
import { AttachmentVersionsService } from './attachments.versions.js';

/**
 * `/v1/attachments/{id}`: one attachment, whatever record it is on. Whoever
 * may read its record reads it (the record's policy, through
 * AttachmentsService); the answer for one they may not is the 404 of a
 * missing one.
 */
@ApiTags('attachments')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiNotFoundResponse({
  description: 'No such attachment, or you may not read its record.',
})
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly versions: AttachmentVersionsService,
  ) {}

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked by AttachmentsService: reading the record.
  @ApiOperation({
    summary: 'One attachment',
    description:
      'Its ETag is what `If-Match` takes to replace or restore it (`POST …/attachments/{attachmentId}/versions`, `…/versions/{version}/restore`).',
  })
  @ApiOkResponse({ standardSchema: attachmentSchema })
  get(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.get(user, id);
  }

  @Get(':id/versions')
  @Can.Anyone() // Checked by AttachmentsService: reading the record.
  @ApiOperation({
    summary: "An attachment's versions, the current one first",
    description:
      'Whoever may read its record: each version with who put it in place, when and the note.',
  })
  @ApiOkResponse({ standardSchema: attachmentVersionListSchema })
  listVersions(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.versions.list(user, id);
  }

  @Get(':id/versions/:version/download')
  @Redirect()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Download one version of an attachment',
    description: `Whoever may read its record. A 302 to a signed link to that version's file, valid for ${DOWNLOAD_LINK_TTL}, as a download (never inline). The current version downloads as \`GET /v1/attachments/{id}/download\` does.`,
  })
  @ApiFoundResponse({ description: 'The signed link, in `Location`.' })
  @ApiNotFoundResponse({
    description:
      'No such attachment, or version (attachment_version_not_found).',
  })
  async downloadVersion(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    const { url } = await this.versions.download(user, id, version);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Post(':id/versions/:version/restore')
  @Can.Anyone() // Checked by AttachmentVersionsService: changing the record.
  @ApiHeader(ifMatchHeader())
  @ApiOperation({
    summary: 'Restore an earlier version of an attachment',
    description:
      "Who may change its record. The version's bytes become the current file again as a new version (nothing is lost), scanned again like an upload. Audited (attachment.version-restored). With `If-Match` (the attachment's ETag) refused (412) if it changed since you read it.",
  })
  @ApiCreatedResponse({ standardSchema: attachmentSchema })
  @ApiForbiddenResponse({ description: 'You may not change the record.' })
  @ApiNotFoundResponse({
    description:
      'No such attachment, or version (attachment_version_not_found).',
  })
  @ApiConflictResponse({
    description:
      'An issued document (attachment_locked), still being scanned or processed (attachment_busy), or at the limit of versions (attachment_versions_limit).',
  })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  restoreVersion(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body({ schema: attachmentRestoreSchema }) body: { note?: string },
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.versions.restore(user, id, version, {
      ifMatch,
      note: body.note,
      ip,
    });
  }

  @Get(':id/download')
  @Redirect()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Download the file',
    description:
      "A 302 to a signed link to the file (5 minutes, no credentials needed: a link or an image works). `?inline=true` shows a PDF in the browser; `?rendition=thumb|preview` links to an image's smaller copy. 409 `attachment_scan_pending` while it is being scanned.",
  })
  @ApiFoundResponse({ description: 'The signed link, in `Location`.' })
  @ApiConflictResponse({
    description: 'Still being scanned for malware (attachment_scan_pending).',
  })
  async download(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: downloadQuerySchema }) query: DownloadQuery,
  ) {
    const { url } = await this.attachments.download(user, id, {
      inline: query.inline === 'true',
      rendition: query.rendition,
    });
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Remove an attachment',
    description:
      'The uploader, or whoever may change the record; the file goes too. Audited. 409 for an issued document (attachment_locked) or a record under a legal hold.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'You may not remove this attachment.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.attachments.remove(user, id, ip);
  }
}

/**
 * `/<path>/{id}/attachments`: a record's attachments, listed and uploaded.
 * Whoever may read the record lists them; whoever may change it uploads.
 */
export function recordAttachmentsController(record: RecordDeclaration): Type {
  @ApiNotFoundResponse({ description: `No such ${record.noun}.` })
  @RecordController(record, ':id/attachments', 'Attachments')
  class RecordAttachmentRoutes {
    constructor(
      private readonly attachments: AttachmentsService,
      private readonly uploads: AttachmentUploadsService,
      private readonly versions: AttachmentVersionsService,
    ) {}

    @Get()
    @Can.Anyone() // Checked by AttachmentsService: reading the record.
    @ApiOperation({
      summary: `${aNoun(record)}'s attachments, newest first`,
      description:
        'Cursor pages; `?contentType=`, `?name.contains=`, `?scanStatus=`, `?size.gte=`, `?createdAt.gte=`.',
    })
    @ApiOkResponse({ standardSchema: attachmentPageSchema })
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: ATTACHMENT_LIST.schema }) query: ListQuery,
    ) {
      return ATTACHMENT_LIST.pick(
        await this.attachments.list(
          user,
          { subject: record.subject, recordId: id },
          query,
        ),
        query,
      );
    }

    @Post()
    @Can.Anyone() // Checked by the interceptor: changing the record.
    @UseInterceptors(attachmentUpload(record.subject))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
      summary: `Attach a file to ${aNoun(record)}`,
      description:
        'Multipart, the field `file`: its type is read from its bytes and must be allowed (ATTACHMENT_ALLOWED_TYPES; `attachmentLimits` in GET /v1/lists/{subject}), its size at most ATTACHMENT_MAX_MB. Streamed onto the private disk. Audited (`attachment.added`).',
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiBadRequestResponse({ description: 'No file in the field `file`.' })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description: 'Not an allowed type, or not the type declared.',
    })
    upload(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @UploadedFile() file: StoredUpload | undefined,
      @Body({ schema: attachmentUploadSchema }) _body: unknown,
      @Ip() ip: string,
    ) {
      if (!file) {
        throw new BadRequestException('Attach the file as the "file" field.');
      }
      return this.attachments.upload(
        user,
        { subject: record.subject, recordId: id },
        file,
        ip,
      );
    }

    @Post(':attachmentId/versions')
    @Can.Anyone() // Checked by the interceptor: changing the record.
    @UseInterceptors(attachmentUpload(record.subject))
    @ApiConsumes('multipart/form-data')
    @ApiHeader(ifMatchHeader())
    @ApiOperation({
      summary: `Replace the file of ${aNoun(record)}'s attachment with a new version`,
      description:
        "Who may change the record. Multipart: the field `file` (checked like any upload: type from its bytes, size, quota, malware scan) and an optional `note`. The file it replaces stays as the previous version (`GET /v1/attachments/{id}/versions`). With `If-Match` (the attachment's ETag) it is refused (412) if the attachment changed since you read it. Audited (attachment.replaced).",
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiConflictResponse({
      description:
        'An issued document (attachment_locked), still being scanned or processed (attachment_busy), or at the limit of versions (attachment_versions_limit).',
    })
    @ApiPreconditionFailedResponse({
      description: 'It changed since you read it (precondition_failed).',
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description: 'Not an allowed type, or not the type declared.',
    })
    replace(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
      @UploadedFile() file: StoredUpload | undefined,
      @Body({ schema: attachmentVersionNoteSchema }) body: { note?: string },
      @Headers('if-match') ifMatch: string | undefined,
      @Ip() ip: string,
    ) {
      if (!file) {
        throw new BadRequestException('Attach the file as the "file" field.');
      }
      return this.versions.replace(
        user,
        { subject: record.subject, recordId: id },
        attachmentId,
        file,
        { ifMatch, note: body.note, ip },
      );
    }

    @Post('presign')
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Announce a direct upload of a file to ${aNoun(record)}`,
      description:
        "For STORAGE_DRIVER=s3, instead of streaming the file through the API. Send the file's name, size and type: the answer is a URL to PUT the file to (signed for exactly that size and `Content-Type`, for ten minutes, at a key the server chose under your tenant) and an `uploadId`. Then `POST …/attachments/complete` with it. Nothing is attached until then.",
    })
    @ApiCreatedResponse({ standardSchema: presignedUploadSchema })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description: 'A type not allowed, or none declared.',
    })
    @ApiTooManyRequestsResponse({
      description:
        'Too many uploads announced and not completed (attachment_uploads_pending).',
    })
    @ApiServiceUnavailableResponse({
      description:
        'The server stores files on a local disk (presigned_uploads_unavailable): upload with a multipart POST or a session.',
    })
    presign(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentAnnounceSchema }) body: AttachmentAnnounce,
    ) {
      return this.uploads.presign(
        user,
        { subject: record.subject, recordId: id },
        body,
      );
    }

    @Post('complete')
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Complete a direct or resumable upload to ${aNoun(record)}`,
      description:
        'After the PUT to the URL of `…/presign`, or after the last chunk of a session (`…/sessions`): the server reads the object back (its size and type from the store, its first bytes for the type the bytes say), deletes it if it is not what was announced, and otherwise attaches it exactly as an upload through the API does (`attachment.added`, the quota, the malware scan, the image renditions). Only the one who announced the upload may complete it.',
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiBadRequestResponse({
      description:
        'The object is not the size and type announced (attachment_upload_mismatch); it is deleted.',
    })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiNotFoundResponse({
      description: 'No such upload of yours (attachment_upload_not_found).',
    })
    @ApiConflictResponse({
      description:
        'Nothing was PUT yet or chunks are missing (attachment_upload_incomplete: try again), or another request is completing it (attachment_upload_in_progress).',
    })
    @ApiGoneResponse({
      description:
        "More than an hour past the URL's expiry (attachment_upload_expired): announce it again.",
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB; deleted.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description:
        'The bytes are a type not allowed, or not the one declared; deleted.',
    })
    complete(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentCompleteSchema }) body: { uploadId: string },
      @Ip() ip: string,
    ) {
      return this.uploads.complete(
        user,
        { subject: record.subject, recordId: id },
        body.uploadId,
        ip,
      );
    }

    @Post('sessions')
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Start a resumable upload of a file to ${aNoun(record)}`,
      description:
        "For large files and flaky connections, on every storage driver. Send the file's name, size and type: the same checks as `…/presign` (size, type, the tenant's storage quota, at most 100 open uploads). The answer is a session to send the file to in chunks (`PUT …/attachments/sessions/{uploadId}?offset=`), then `POST …/attachments/complete`. Nothing is attached, listed or downloadable until then. A session lasts 24 hours.",
    })
    @ApiCreatedResponse({ standardSchema: uploadSessionSchema })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description: 'A type not allowed, or none declared.',
    })
    @ApiTooManyRequestsResponse({
      description: 'Too many uploads open (attachment_uploads_pending).',
    })
    startSession(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentAnnounceSchema }) body: AttachmentAnnounce,
    ) {
      return this.uploads.start(
        user,
        { subject: record.subject, recordId: id },
        body,
      );
    }

    @Get('sessions/:uploadId')
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Progress of a resumable upload to ${aNoun(record)}`,
      description:
        'How many bytes were received: continue from there after an interruption. Your own sessions only.',
    })
    @ApiOkResponse({ standardSchema: uploadSessionSchema })
    @ApiNotFoundResponse({
      description:
        'No such open upload of yours (attachment_upload_not_found).',
    })
    sessionProgress(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
    ) {
      return this.uploads.progress(
        user,
        { subject: record.subject, recordId: id },
        uploadId,
      );
    }

    @Put('sessions/:uploadId')
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Send a chunk of a resumable upload to ${aNoun(record)}`,
      description:
        "The raw bytes as the body (`application/octet-stream`), at most the session's `chunkSize`, starting at `?offset=`, which must be the `received` of the last answer. A retried or parallel chunk at a stale offset is a 409 and stores nothing: read `received` and continue.",
    })
    @ApiConsumes('application/octet-stream')
    @ApiBody({ schema: { type: 'string', format: 'binary' } })
    @ApiOkResponse({ standardSchema: uploadSessionSchema })
    @ApiForbiddenResponse({
      description: `You may not change this ${record.noun}.`,
    })
    @ApiNotFoundResponse({
      description:
        'No such open upload of yours (attachment_upload_not_found).',
    })
    @ApiConflictResponse({
      description:
        'The offset is not the next one (attachment_upload_offset_mismatch), or the upload is being completed.',
    })
    @ApiGoneResponse({
      description: 'The session expired (attachment_upload_expired).',
    })
    @ApiPayloadTooLargeResponse({
      description: 'The chunk is larger than allowed.',
    })
    sessionChunk(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
      @Query({ schema: uploadChunkQuerySchema }) query: { offset: number },
      @Req() request: NodeRequest,
    ) {
      return this.uploads.append(
        user,
        { subject: record.subject, recordId: id },
        uploadId,
        query.offset,
        request,
      );
    }

    @Delete('sessions/:uploadId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone() // Checked by AttachmentUploadsService: changing the record.
    @ApiOperation({
      summary: `Cancel a resumable upload to ${aNoun(record)}`,
      description:
        'The chunks received are deleted at once. Your own sessions only.',
    })
    @ApiNoContentResponse()
    @ApiNotFoundResponse({
      description:
        'No such open upload of yours (attachment_upload_not_found).',
    })
    @ApiConflictResponse({
      description:
        'The upload is being completed (attachment_upload_in_progress).',
    })
    async cancelSession(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
    ) {
      await this.uploads.cancel(
        user,
        { subject: record.subject, recordId: id },
        uploadId,
      );
    }
  }
  return RecordAttachmentRoutes;
}

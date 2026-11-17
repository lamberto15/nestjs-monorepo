import { Public } from '@nestjs/authentication';
import {
  Controller,
  Get,
  Put,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import {
  receiveSignedUpload,
  serveSignedUrl,
  StorageDisk,
} from '@nestjs/storage';
import { ApiExcludeController } from '@nestjs/swagger';
import { FILES_ROUTE } from './storage.disks.js';

/**
 * The Content-Security-Policy of a served file (a PDF shown inline above
 * all): nothing may load, nothing frames it, and it runs as a unique origin
 * without scripts, forms or popups. `nosniff` comes from serveSignedUrl.
 */
export const FILE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Serves the private disk's signed URLs when it is a local disk: the
 * signature in the query string is the credential (no session needed), it
 * names one key, one method and an expiry. With S3 the URLs point at the
 * bucket and this route answers 404. A URL is issued only after the route
 * that issues it checked access, so a URL never reaches a file its holder
 * wasn't given.
 */
@ApiExcludeController()
@Public()
@Controller({ path: FILES_ROUTE, version: VERSION_NEUTRAL })
export class FilesController {
  constructor(private readonly disk: StorageDisk) {}

  @Get()
  download(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A file is never a page: it loads nothing and runs nothing. Replaces the
    // app's policy for these responses.
    res.setHeader('Content-Security-Policy', FILE_CSP);
    return serveSignedUrl(this.disk, { req, res });
  }

  @Put()
  async upload(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await receiveSignedUpload(this.disk, { req, res });
  }
}

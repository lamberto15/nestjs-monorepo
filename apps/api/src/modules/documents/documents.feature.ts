import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { PdfRenderer } from './pdf-renderer.js';

/** `documents` of `GET /v1/features`: whether PDFs can be made, as the renderer decides it. */
@Feature({
  documents: z
    .boolean()
    .describe(
      'PDF documents of records. Off: no renderer (GOTENBERG_URL) is configured, and issuing one is refused.',
    ),
})
@Injectable()
export class DocumentsFeature implements FeatureSwitch {
  constructor(private readonly pdf: PdfRenderer) {}

  value() {
    return this.pdf.enabled;
  }
}

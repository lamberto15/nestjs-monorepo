import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/** The malware scan of uploads, run as `system:attachment-scan`: it writes only its audit entries. */
export const ATTACHMENT_SCAN_JOB = defineSystemJob({
  key: 'attachment-scan',
  permissions: [],
});

/** The thumbnails and metadata stripping of images, run as `system:attachment-images`. */
export const ATTACHMENT_IMAGES_JOB = defineSystemJob({
  key: 'attachment-images',
  permissions: [],
});

/** The text extraction for the search inside files, run as `system:attachment-text`. */
export const ATTACHMENT_TEXT_JOB = defineSystemJob({
  key: 'attachment-text',
  permissions: [],
});

/** The nightly removal of uploads nobody completed, run as `system:attachment-sweep`. */
export const ATTACHMENT_SWEEP_JOB = defineSystemJob({
  key: 'attachment-sweep',
  permissions: [],
});

/** What attachments add to the catalog: the jobs that work without a user. */
export const ATTACHMENT_PERMISSIONS = definePermissions({
  systemJobs: [
    ATTACHMENT_SCAN_JOB,
    ATTACHMENT_IMAGES_JOB,
    ATTACHMENT_TEXT_JOB,
    ATTACHMENT_SWEEP_JOB,
  ],
});

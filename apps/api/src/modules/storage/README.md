# modules/storage

Files on [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md):
one private disk, `files` (the default; inject `StorageDisk`). Nothing is public:
clients get short-lived signed URLs (`signedUrl()`, `signedUpload()`). On the
local disk the app serves them at `/files` (`FilesController`, GET and PUT,
with a locked-down Content-Security-Policy); on S3 they point at the bucket.

- `storage.keys.ts`: `tenantFileKey(tenantId, path)`, `accountFileKey(userId, path)`
  and `isTenantFileKey()` build and check object keys. The tenant is an argument.
- `storage.diagnostic.ts` registers the operators' storage test (`@Diagnostic` of modules/ops).
- Add disks in `storage.disks.ts`; inject them with `@InjectDisk('name')`.

## Variables (`storage.config.ts`)

STORAGE_DRIVER (`local`, `s3`, `memory`), STORAGE_ROOT, STORAGE_SIGNING_KEYS,
S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_FORCE_PATH_STYLE. S3 credentials
are the standard AWS_* variables or the instance role.

## Remove

Delete this folder and its line in `app.module.ts`; modules that store files
go with it.

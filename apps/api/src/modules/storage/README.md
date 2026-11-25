# modules/storage

Files on [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md):
one private disk, `files` (the default; inject `StorageDisk`). Nothing is public:
clients get short-lived signed URLs (`signedUrl()`, `signedUpload()`). On the
local disk the app serves them at `/files` (`FilesController`, GET and PUT,
with a locked-down Content-Security-Policy); on S3 they point at the bucket.

- `storage.keys.ts`: `tenantFileKey(tenantId, path)`, `accountFileKey(userId, path)`
  and `isTenantFileKey()` build and check object keys. The tenant is an argument.
- **Deleting after the commit** (`storage.release.ts`): a module that deletes
  rows naming files calls `StoredFiles.release(keys)` in that transaction
  (import `StoredFilesModule`). It publishes `storage.files-released` through the
  outbox, and the worker deletes the files once the transaction commits; a
  rollback keeps them. Deleting is idempotent and a failure is retried.
  Attachments, documents and branding use it.
- **Erasure** (`storage.erasure.ts`): every file under `tenants/<id>/` goes
  with the tenant (`tenancy.tenant-erasing`, in TenantsService.purge()'s
  transaction: the operator's deletion and the sign-up sweep), and every
  file under `accounts/<id>/` (picture, data exports) with the account
  (the `account-files` section of iam/personal-data), both after the commit.
- `storage.diagnostic.ts` registers the operators' storage test (`@Diagnostic` of modules/ops).
- Add disks in `storage.disks.ts`; inject them with `@InjectDisk('name')`.

## Variables (`storage.config.ts`)

STORAGE_DRIVER (`local`, `s3`, `memory`), STORAGE_ROOT, STORAGE_SIGNING_KEYS,
S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_FORCE_PATH_STYLE, STORAGE_SHARED.
S3 credentials are the standard AWS_* variables or the instance role.
With `APP_ROLE` `api` or `worker` (a split deployment) in production
(`NODE_ENV=production`) the local driver refuses to start unless `STORAGE_SHARED=on`: the API's uploads must be on a
disk the worker sees.

## Remove

`pnpm module:remove storage` ([removing-a-module](../../../../../docs/removing-a-module.md)).

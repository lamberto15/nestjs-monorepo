# create-nestjs-monorepo

Starts a project from the [nestjs-monorepo](https://github.com/lamberto15/nestjs-monorepo)
template: a NestJS 12 API, the web app it serves and a typed client, in one
pnpm workspace.

```bash
pnpm create nestjs-monorepo my-app
```

It clones the newest release of the template with its history, keeps the
template as the `template` git remote, names the project after its folder,
commits that on `main` and runs `pnpm install`. A later release is merged
like a branch: the template's
[docs/upgrading.md](https://github.com/lamberto15/nestjs-monorepo/blob/main/docs/upgrading.md).

| Option              | What                                               |
| ------------------- | -------------------------------------------------- |
| `--version <x.y.z>` | a release of the template (default: the newest)    |
| `--from <git url>`  | the template's repository (default: the one above) |
| `--no-install`      | skip `pnpm install`                                |

Needs Node 26 or later, git and pnpm. The version in `package.json` is set
by the release workflow from the tag (`template.json`'s version): the
package and the template are released together.

Licence: [PolyForm Noncommercial 1.0.0](https://github.com/lamberto15/nestjs-monorepo/blob/main/LICENSE),
the template's.

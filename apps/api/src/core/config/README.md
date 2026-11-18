# core/config

How a module declares and reads its environment variables. There is no central
env file or schema: each module's `<name>.config.ts` holds its own.

- **Declare** in your module's `<name>.config.ts`: `export const schema = z.object({...})` (the file must export `schema`) and a `registerAs()` namespace that calls `readEnv(schema)`. Import the namespace in the module with `ConfigModule.forFeature(yourConfig)` and inject it with `@Inject(yourConfig.KEY)`.
- **Helpers** (`env.helpers.ts`): `required()`, `optional()`, `withDefault()`, `integer(default, { min, max })`, `flag('on' | 'off')` (a boolean), `choice([...], default)`, `list()` (comma separated), `baseUrl()`. An empty value (`FOO=`) counts as unset. Plain Zod works too.
- **Document** every variable with a comment or `.describe()` (the line in `env.example`) and `.meta({ example })` for a required one.
- **Secrets:** wrap the variable in `secret()`: it can also be given as `X_FILE`, the path of a file holding the value (a Docker or Kubernetes secret; both `X` and `X_FILE` is an error), and the logger masks it.
- **A wrong value stops the start** and names every variable at fault, never its value (`readEnv()`, `env.ts`).
- `env.example` is generated from the schemas (`pnpm env:example`; `pnpm env:check` in CI). Never edit it by hand, never write `.env` files from code.

Always there: the app imports `ConfigModule.forRoot()` itself (`app.module.ts`); this folder is a library, with no module to remove.

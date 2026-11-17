import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Client, type ClientBase, escapeIdentifier, escapeLiteral } from 'pg';

/**
 * The roles of one database (README.md, "Roles"): the owner's, which owns
 * the tables and runs the migrations; the app's, which api and worker
 * connect as; and, when given, the maintenance role's, for work across
 * every tenant. Same server, same database.
 */
export type DatabaseUrls = {
  ownerUrl: string;
  appUrl: string;
  maintenanceUrl?: string;
};

type Credentials = { role: string; password: string; database: string };

const INSUFFICIENT_PRIVILEGE = '42501';
const DUPLICATE_OBJECT = '42710';
const INVALID_PASSWORD = '28P01';

/**
 * Makes DATABASE_URL's role (and DATABASE_MAINTENANCE_URL's) fit, as the
 * owner, after every migration: the role exists with the URL's password; it
 * is no superuser, creates neither databases nor roles, is a member of no
 * role, owns nothing and may CREATE nowhere; it may read and write every
 * table and use every sequence of the app's schemas (`public` and the
 * owner's, not `drizzle`, the migrations' journal), today's and those the
 * owner creates later (ALTER DEFAULT PRIVILEGES). The app's role never
 * bypasses row-level security; the maintenance role must. Then `secure`
 * (the tenant wall, core/tenancy) runs in the same transaction, and
 * nothing commits unless all of it holds.
 *
 * Idempotent. An existing role's attributes are checked, never changed: a
 * role someone made a superuser is refused with the statement that fixes
 * it. Code, not a migration: drizzle-kit emits no GRANT, and the roles'
 * names and passwords are the deployment's. Works without a superuser (a
 * managed PostgreSQL's admin with CREATEROLE), except that only a superuser
 * (or a BYPASSRLS role) may create the maintenance role: then make it once
 * by hand, as the error says.
 */
export async function ensureRoles(
  urls: DatabaseUrls,
  secure: (owner: ClientBase, log: (line: string) => void) => Promise<void>,
  log: (line: string) => void = () => {},
) {
  const owner = credentials(urls.ownerUrl, 'DATABASE_OWNER_URL');
  const app = credentials(urls.appUrl, 'DATABASE_URL');
  const maintenance = urls.maintenanceUrl
    ? credentials(urls.maintenanceUrl, 'DATABASE_MAINTENANCE_URL')
    : undefined;
  if (owner.role === app.role) {
    throw new Error(
      `DATABASE_URL and DATABASE_OWNER_URL both connect as "${app.role}": the app would own its tables. Give the app a role of its own (core/database/README.md, "Roles").`,
    );
  }
  if (maintenance && [app.role, owner.role].includes(maintenance.role)) {
    throw new Error(
      `DATABASE_MAINTENANCE_URL connects as "${maintenance.role}", the role of DATABASE_URL or DATABASE_OWNER_URL: the maintenance role must be one of its own.`,
    );
  }
  const client = new Client({
    connectionString: urls.ownerUrl,
    application_name: 'migrate:roles',
  });
  await client.connect();
  const roles = [
    { credentials: app, bypassRls: false },
    ...(maintenance ? [{ credentials: maintenance, bypassRls: true }] : []),
  ];
  const created = new Set<string>();
  try {
    await client.query('begin');
    // One bootstrap at a time (two deploys, or a deploy and a developer).
    await client.query(
      `select pg_advisory_xact_lock(hashtext('nestjs-monorepo:roles'))`,
    );
    const schemas = await applicationSchemas(client, owner.role);
    for (const role of roles) {
      if (await ensureRole(client, role.credentials, role.bypassRls, log)) {
        created.add(role.credentials.role);
      }
      await grantConnect(client, role.credentials, log);
      for (const schema of schemas) {
        await grantSchema(client, owner.role, role.credentials.role, schema);
      }
    }
    await secure(client, log);
    for (const role of roles) {
      await assertFit(client, role.credentials.role, schemas);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
  try {
    // After the commit: the check connects as the role, which needs the
    // committed grants. A password is set only when it doesn't work.
    for (const [role, url] of [
      [app, urls.appUrl],
      ...(maintenance ? [[maintenance, urls.maintenanceUrl!] as const] : []),
    ] as const) {
      const isNew = created.has(role.role);
      const set = await ensurePassword(client, role, url, isNew);
      log(
        `Role "${role.role}" ${isNew ? 'created' : 'checked'}${set ? ', password set' : ''}.`,
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The role, password and database of a postgres:// URL. */
function credentials(url: string, name: string): Credentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (!parsed.username) {
    throw new Error(`${name} names no role (postgres://role:secret@host/db).`);
  }
  return {
    role: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

type RoleFlags = {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
};

/** Creates the role when it is missing, or checks its attributes. Returns whether it was created. */
async function ensureRole(
  client: ClientBase,
  role: Credentials,
  bypassRls: boolean,
  log: (line: string) => void,
): Promise<boolean> {
  const name = escapeIdentifier(role.role);
  const { rows } = await client.query<RoleFlags>(
    `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
     from pg_roles where rolname = $1`,
    [role.role],
  );
  if (rows.length === 0) {
    try {
      await client.query('savepoint create_role');
      // Only a SCRAM verifier crosses the wire, never the password, so it
      // never reaches the server's statement log.
      await client.query(
        `create role ${name} login nosuperuser ${bypassRls ? 'bypassrls' : 'nobypassrls'} nocreatedb nocreaterole noreplication inherit password ${escapeLiteral(scramSha256Verifier(role.password))}`,
      );
      await client.query('release savepoint create_role');
      return true;
    } catch (error) {
      await client.query('rollback to savepoint create_role');
      const code = (error as { code?: string }).code;
      if (code === DUPLICATE_OBJECT) {
        // Made meanwhile by a bootstrap of another database on the server.
        return ensureRole(client, role, bypassRls, log);
      }
      if (bypassRls && code === INSUFFICIENT_PRIVILEGE) {
        throw new Error(
          `The owner may not create "${role.role}" with BYPASSRLS (only a superuser may). Create it once as one: CREATE ROLE ${name} LOGIN BYPASSRLS PASSWORD '…'; then migrate again.`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  const flags = rows[0]!;
  const wrong = (
    [
      ['rolsuper', 'NOSUPERUSER'],
      ['rolbypassrls', bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'],
      ['rolcreatedb', 'NOCREATEDB'],
      ['rolcreaterole', 'NOCREATEROLE'],
      ['rolreplication', 'NOREPLICATION'],
    ] as const
  )
    .filter(([flag]) =>
      flag === 'rolbypassrls' ? flags[flag] !== bypassRls : flags[flag],
    )
    .map(([, fix]) => fix);
  if (wrong.length > 0) {
    throw new Error(
      `Role "${role.role}" must not serve the app as it is: run \`ALTER ROLE ${name} ${wrong.join(' ')}\` as a superuser, or give it another role.`,
    );
  }
  if (!flags.rolcanlogin) {
    await client.query(`alter role ${name} login`);
    log(`Role "${role.role}" may log in now.`);
  }
  return false;
}

/**
 * The schemas the app's roles use: `public` and the ones the owner made
 * (a store's), never `drizzle` (the migrations' journal), the system's or
 * another role's (a managed PostgreSQL's own).
 */
async function applicationSchemas(client: ClientBase, owner: string) {
  const { rows } = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace
     where (nspname = 'public' or nspowner = $1::regrole)
       and nspname not in ('drizzle', 'information_schema')
       and nspname not like 'pg\\_%'
     order by 1`,
    [owner],
  );
  return rows.map((row) => row.nspname);
}

/** CONNECT on the database, when the owner may grant it (PUBLIC has it by default anyway). */
async function grantConnect(
  client: ClientBase,
  role: Credentials,
  log: (line: string) => void,
) {
  try {
    await client.query('savepoint connect_grant');
    await client.query(
      `grant connect on database ${escapeIdentifier(role.database)} to ${escapeIdentifier(role.role)}`,
    );
    await client.query('release savepoint connect_grant');
  } catch (error) {
    if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) {
      throw error;
    }
    await client.query('rollback to savepoint connect_grant');
    log(
      `The owner may not grant CONNECT on "${role.database}": "${role.role}" connects through PUBLIC's.`,
    );
  }
}

/** Usage, DML on every table, every sequence, the same on what the owner creates later; never CREATE. */
async function grantSchema(
  client: ClientBase,
  owner: string,
  role: string,
  schema: string,
) {
  const s = escapeIdentifier(schema);
  const r = escapeIdentifier(role);
  const later = `alter default privileges for role ${escapeIdentifier(owner)} in schema ${s}`;
  for (const statement of [
    `grant usage on schema ${s} to ${r}`,
    `revoke create on schema ${s} from ${r}`,
    `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
    `grant usage, select on all sequences in schema ${s} to ${r}`,
    `${later} grant select, insert, update, delete on tables to ${r}`,
    `${later} grant usage, select on sequences to ${r}`,
  ]) {
    await client.query(statement);
  }
}

/**
 * The role fits before anything commits. Membership is the escalation the
 * flags don't show: `GRANT owner TO app` gives the app the owner's rights,
 * every row past the wall included, so the role may be a member of nothing.
 */
async function assertFit(client: ClientBase, role: string, schemas: string[]) {
  const problems: string[] = [];
  const { rows: memberships } = await client.query<{ rolname: string }>(
    `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
     where m.member = $1::regrole order by 1`,
    [role],
  );
  if (memberships.length > 0) {
    problems.push(
      `is a member of ${memberships.map((row) => `"${row.rolname}"`).join(', ')}: run ${memberships
        .map(
          (row) =>
            `REVOKE ${escapeIdentifier(row.rolname)} FROM ${escapeIdentifier(role)}`,
        )
        .join('; ')}`,
    );
  }
  const { rows: owned } = await client.query<{ what: string; count: string }>(
    `select 'relation' as what, count(*)::text from pg_class where relowner = $1::regrole
     union all select 'schema', count(*)::text from pg_namespace where nspowner = $1::regrole
     union all select 'database', count(*)::text from pg_database where datdba = $1::regrole`,
    [role],
  );
  for (const row of owned) {
    if (row.count !== '0') {
      problems.push(`owns ${row.count} ${row.what}(s)`);
    }
  }
  // CREATE can come through PUBLIC too (a database made on PostgreSQL 14
  // or older grants it on `public`), which no REVOKE from the role undoes.
  const { rows: creates } = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace
     where (nspname = any($2::text[]) or nspname = 'public') and has_schema_privilege($1, oid, 'CREATE')`,
    [role, schemas],
  );
  for (const row of creates) {
    problems.push(
      `may CREATE in schema "${row.nspname}" (REVOKE CREATE ON SCHEMA ${escapeIdentifier(row.nspname)} FROM PUBLIC)`,
    );
  }
  const { rows: database } = await client.query<{ create: boolean }>(
    `select has_database_privilege($1, current_database(), 'CREATE') as create`,
    [role],
  );
  if (database[0]?.create) {
    problems.push('may CREATE schemas in the database');
  }
  // One privilege per call: with a list, has_table_privilege is true when ANY is held.
  const { rows: unusable } = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($2::text[])
       and ((c.relkind in ('r', 'p', 'v', 'm')
             and not (has_table_privilege($1, c.oid, 'SELECT')
                      and has_table_privilege($1, c.oid, 'INSERT')
                      and has_table_privilege($1, c.oid, 'UPDATE')
                      and has_table_privilege($1, c.oid, 'DELETE')))
         or (c.relkind = 'S' and not has_sequence_privilege($1, c.oid, 'USAGE')))
     order by 1`,
    [role, schemas],
  );
  if (unusable.length > 0) {
    problems.push(`can't use ${unusable.map((row) => row.name).join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Role "${role}" is not fit for the app: ${problems.join('; ')}. Nothing was changed.`,
    );
  }
}

/** Connects as the role once; a password that fails is set from its URL (a rotated one) and tried again. */
async function ensurePassword(
  owner: ClientBase,
  role: Credentials,
  url: string,
  created: boolean,
) {
  if (created || (await canConnect(url))) {
    if (created && !(await canConnect(url))) {
      throw new Error(
        `Role "${role.role}" can't connect with its URL's password: check pg_hba.conf (scram-sha-256) and the URL.`,
      );
    }
    return false;
  }
  await owner.query(
    `alter role ${escapeIdentifier(role.role)} password ${escapeLiteral(scramSha256Verifier(role.password))}`,
  );
  if (!(await canConnect(url))) {
    throw new Error(
      `Role "${role.role}" can't connect with its URL's password even after setting it: check pg_hba.conf (scram-sha-256) and the URL.`,
    );
  }
  return true;
}

async function canConnect(url: string) {
  const client = new Client({
    connectionString: url,
    application_name: 'migrate:roles',
  });
  try {
    await client.connect();
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === INVALID_PASSWORD) {
      return false;
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 7677: 4096 iterations, a
 * random salt), the form `CREATE ROLE … PASSWORD` stores, computed here
 * so the password never goes to the server. PostgreSQL applies SASLprep
 * first, which changes only non-ASCII characters: keep passwords ASCII.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16)) {
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

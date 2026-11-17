import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/*
 * The e2e tests' databases, made and dropped on the test server. Raw SQL:
 * CREATE and DROP DATABASE have no query-builder form.
 */

/** The URL of database `name` on the server of `serverUrl`. */
export const databaseUrl = (serverUrl: string, name: string) => {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Runs one statement on the server (its URL's database), on a connection of its own. */
export async function onServer(serverUrl: string, statement: string) {
  const client = new Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** `serverUrl`, connecting as `role` with `password`. */
export const asRole = (serverUrl: string, role: string, password: string) => {
  const url = new URL(serverUrl);
  url.username = role;
  url.password = password;
  return url.toString();
};

/**
 * A database of its own, named `<prefix>_<random>`: a copy of `template`
 * (FILE_COPY, fast for a small database), or empty without one, owned by
 * `owner` (the run's owner role) when given. `drop()` ends whatever is
 * still connected to it.
 */
export async function createDatabase(
  serverUrl: string,
  prefix: string,
  template?: string,
  owner?: string,
) {
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await onServer(
    serverUrl,
    `create database "${name}"${owner ? ` owner "${owner}"` : ''}${
      template ? ` template "${template}" strategy file_copy` : ''
    }`,
  );
  return {
    name,
    url: databaseUrl(serverUrl, name),
    drop: () =>
      onServer(serverUrl, `drop database if exists "${name}" with (force)`),
  };
}

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

/**
 * A database of its own, named `<prefix>_<random>`: a copy of `template`
 * (FILE_COPY, fast for a small database), or empty without one. `drop()`
 * ends whatever is still connected to it.
 */
export async function createDatabase(
  serverUrl: string,
  prefix: string,
  template?: string,
) {
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await onServer(
    serverUrl,
    template
      ? `create database "${name}" template "${template}" strategy file_copy`
      : `create database "${name}"`,
  );
  return {
    name,
    url: databaseUrl(serverUrl, name),
    drop: () =>
      onServer(serverUrl, `drop database if exists "${name}" with (force)`),
  };
}

import { NestFactory } from '@nestjs/core';
import { createLogger } from '../core/logging/logging.js';
import { DemoAppModule } from './demo-app.module.js';
import { DemoSeedRefused, nodeEnvRefusal } from './demo.guard.js';
import { type DemoSeedResult, DemoSeeder } from './demo.seeder.js';

/**
 * What the seed made, for the terminal: straight to stdout, never through
 * the app's logger (which may ship its lines elsewhere): the passwords are
 * in no log. apps/web-e2e/scripts/api.mjs reads the accounts' lines:
 * `  <email>  <password>  <name> (<roles>)`.
 */
function report(result: DemoSeedResult) {
  if (!result.seeded) {
    console.log(
      `The demo data is already here (seeded ${result.since.toISOString()}): nothing changed. Its passwords were shown then.`,
    );
    return;
  }
  console.log(
    `Demo data in the tenant "${result.tenant}": ${result.users.length} users, ${result.units} units. Their passwords, shown once:\n`,
  );
  const width = Math.max(...result.users.map((user) => user.email.length));
  for (const user of result.users) {
    console.log(
      `  ${user.email.padEnd(width)}  ${user.password}  ${user.name} (${user.roles.join(', ')})`,
    );
  }
  console.log(
    result.operators
      ? `\nThey sign in to "${result.tenant}", the deployment's one tenant (TENANCY=single), which is the operators': its administrator (the first above) acts as an operator too.`
      : "\nThey sign in to the demo tenant (its administrator: the first above). The operators' administrator is the first start's (ADMIN_EMAIL).",
  );
}

// NODE_ENV before the app boots: production never connects, let alone migrates.
// (Importing the app has read .env into process.env.)
const refused = nodeEnvRefusal(process.env.NODE_ENV);
if (refused) {
  console.error(refused);
  process.exit(1);
}
const app = await NestFactory.createApplicationContext(DemoAppModule, {
  // The app's logger (its redaction included), warnings and errors only.
  logger: createLogger({ level: 'warn', json: false }),
});
try {
  report(await app.get(DemoSeeder).seed());
} catch (error) {
  if (!(error instanceof DemoSeedRefused)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await app.close();
}

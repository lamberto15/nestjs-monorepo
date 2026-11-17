import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ClsModule } from 'nestjs-cls';
import { databaseConfig } from './database.config.js';
import { DatabaseReadiness } from './database.readiness.js';
import type { Database } from './database.js';
import { migrateDatabase } from './migrations.js';

/**
 * PostgreSQL through Drizzle (DrizzleModule is global), and transactions
 * that follow the call through AsyncLocalStorage (nestjs-cls's
 * transactional plugin, as docs.nestjs.com/data/drizzle recommends): see
 * database.ts for how services use them. Each app instance gets its own
 * pool, closed when the app shuts down.
 */
@Module({
  imports: [
    DrizzleModule.forRootAsync({
      imports: [ConfigModule.forFeature(databaseConfig)],
      inject: [databaseConfig.KEY],
      // Nest creates nothing that injects the database before this resolves,
      // so pending migrations are applied before the first query.
      useFactory: async (config: ConfigType<typeof databaseConfig>) => {
        if (config.migrateOnStart) {
          await migrateDatabase(config.url);
        }
        return {
          drizzle,
          connection: {
            connectionString: config.url,
            max: config.poolMax,
            // Fail fast when the pool is exhausted, never hang.
            connectionTimeoutMillis: config.poolTimeoutMs,
            // Server-side limits, so a slow query or a forgotten transaction
            // can't hold a connection for ever (0: none).
            statement_timeout: config.statementTimeoutMs || undefined,
            idle_in_transaction_session_timeout:
              config.idleTxTimeoutMs || undefined,
            application_name: config.applicationName,
          },
        };
      },
    }),
    // A plugin module is global: TransactionHost and @InjectTransaction()
    // reach every module. It needs no ClsModule.forRoot(): a transaction
    // opens its own CLS context.
    ClsModule.registerPlugins([
      new ClsPluginTransactional({
        adapter: new TransactionalAdapterDrizzleOrm<Database>({
          drizzleInstanceToken: getDrizzleToken(),
        }),
        enableTransactionProxy: true,
      }),
    ]),
  ],
  providers: [DatabaseReadiness],
})
export class DatabaseModule {}

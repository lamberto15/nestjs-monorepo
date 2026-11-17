import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseConfig } from './database.config.js';

/**
 * PostgreSQL through Drizzle. Inject it anywhere with `@InjectDrizzle()`
 * (typed `Database`): DrizzleModule is global. Each app instance gets its
 * own pool, closed when the app shuts down.
 */
@Module({
  imports: [
    DrizzleModule.forRootAsync({
      imports: [ConfigModule.forFeature(databaseConfig)],
      inject: [databaseConfig.KEY],
      useFactory: (config: ConfigType<typeof databaseConfig>) => ({
        drizzle,
        connection: { connectionString: config.url, max: config.poolMax },
      }),
    }),
  ],
})
export class DatabaseModule {}

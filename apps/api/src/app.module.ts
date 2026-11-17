import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './core/database/database.module.js';
import { HealthModule } from './core/health/health.module.js';

/**
 * Every module of the app, listed here and nowhere else. A module owns its
 * routes, tables, environment variables and tests, so removing one is
 * deleting its folder and its line below (AGENTS.md, "Modules").
 */
@Module({
  imports: [
    // Loads .env into process.env; each module reads and checks its own
    // variables in its *.config.ts.
    ConfigModule.forRoot(),
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}

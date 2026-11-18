import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { DemoModule } from './demo.module.js';

/** The app plus the demo seed: what `pnpm db:seed:demo` boots (run-demo-seed.ts). */
@Module({ imports: [AppModule, DemoModule] })
export class DemoAppModule {}

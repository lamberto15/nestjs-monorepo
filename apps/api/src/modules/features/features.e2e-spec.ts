import { Injectable, Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { FeaturesModule } from './features.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-features-${process.pid}-${Date.now()}`;
});

@Feature('widgets')
@Injectable()
class WidgetsFeature implements FeatureSwitch {
  value() {
    return true;
  }
}

@Feature('locales')
@Injectable()
class LocalesFeature implements FeatureSwitch {
  value() {
    return ['en', 'pt'];
  }
}

@Module({ providers: [WidgetsFeature, LocalesFeature] })
class TestFeaturesModule {}

describe('features (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      FeaturesModule,
      TestFeaturesModule,
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  it('tells each switch the modules report, to any signed-in caller', async () => {
    const { admin } = await tenantWithAdmin(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/features',
      headers: admin.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ widgets: true, locales: ['en', 'pt'] });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/features' })).statusCode,
    ).toBe(401);
  });
});

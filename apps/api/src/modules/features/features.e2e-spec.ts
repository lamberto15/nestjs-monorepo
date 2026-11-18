import { Injectable, Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { z } from 'zod';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { buildOpenApiDocument } from '../../core/http/openapi.js';
import { FeaturesModule } from './features.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-features-${process.pid}-${Date.now()}`;
});

@Feature({ widgets: z.boolean() })
@Injectable()
class WidgetsFeature implements FeatureSwitch {
  value() {
    return true;
  }
}

@Feature({ widgetSizes: z.array(z.string()) })
@Injectable()
class WidgetSizesFeature implements FeatureSwitch {
  value() {
    return ['s', 'm'];
  }
}

@Module({ providers: [WidgetsFeature, WidgetSizesFeature] })
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
    // Core's own switches (tenancy, locales) are there too.
    expect(response.json()).toMatchObject({
      widgets: true,
      widgetSizes: ['s', 'm'],
      tenancy: 'multi',
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/features' })).statusCode,
    ).toBe(401);
  });

  it("names each declared switch in the OpenAPI document, with its value's schema", () => {
    const answer = buildOpenApiDocument(app).paths['/v1/features']!.get!
      .responses['200'] as { content: Record<string, { schema: unknown }> };
    expect(answer.content['application/json']!.schema).toMatchObject({
      type: 'object',
      properties: {
        widgets: { type: 'boolean' },
        widgetSizes: { type: 'array', items: { type: 'string' } },
      },
      required: expect.arrayContaining(['widgets', 'widgetSizes']),
    });
  });
});

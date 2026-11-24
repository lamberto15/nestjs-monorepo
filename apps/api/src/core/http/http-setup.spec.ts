import { Controller, Get, Ip, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { createHttpAdapter } from './http-setup.js';

@Controller('ip')
class IpController {
  @Get()
  ip(@Ip() ip: string) {
    return { ip };
  }
}

@Module({ controllers: [IpController] })
class IpModule {}

/** The client address of a request from loopback that names another in X-Forwarded-For. */
async function addressSeen(trustProxy: string | undefined) {
  const before = process.env.TRUST_PROXY;
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  try {
    const app = await NestFactory.create<NestNodeApplication>(
      IpModule,
      createHttpAdapter(),
      { logger: false },
    );
    await app.init();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      return (response.json() as { ip: string }).ip;
    } finally {
      await app.close();
    }
  } finally {
    if (before === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = before;
  }
}

describe('trusted proxies (TRUST_PROXY)', () => {
  it('believe X-Forwarded-For from loopback and private networks when unset', async () => {
    expect(await addressSeen(undefined)).toBe('203.0.113.7');
  });

  it('believe it only from the proxies named', async () => {
    expect(await addressSeen('10.0.3.7')).toBe('127.0.0.1');
    expect(await addressSeen('10.0.3.7, loopback')).toBe('203.0.113.7');
  });
});

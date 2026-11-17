import { once } from 'node:events';
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { Redis } from 'ioredis';
import {
  closeRedis,
  producerRedisOptions,
  redisOptions,
  type RedisSettings,
  redisResponds,
} from './redis.js';

/**
 * Shutdown with Redis gone must not hang: closeRedis() and redisResponds()
 * against a port nothing listens on (Redis removed) and against a server
 * that accepts connections but never answers (Redis frozen).
 */
describe('closing Redis clients at shutdown', () => {
  let silent: Server;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    silent = createServer((socket) => sockets.push(socket));
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    silent.close();
    await once(silent, 'close');
  });

  /** A port that was just free: connections are refused. */
  async function closedPort() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    return port;
  }

  it('closes at once a client that is reconnecting, with a command queued', async () => {
    const client = new Redis({
      port: await closedPort(),
      host: '127.0.0.1',
      // As the app's clients: commands wait for a reconnect.
      maxRetriesPerRequest: null,
      retryStrategy: () => 50,
    });
    client.on('error', () => undefined);
    void client.get('key').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.status).not.toBe('ready');
    expect(await redisResponds(client, 200)).toBe(false);

    const started = Date.now();
    await closeRedis(client, 5000);
    expect(Date.now() - started).toBeLessThan(500);
    // And it stops trying to reconnect: nothing keeps the process alive.
    let attempts = 0;
    client.on('connecting', () => attempts++);
    client.on('reconnecting', () => attempts++);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(attempts).toBe(0);
  });

  it('gives up on QUIT after the timeout when the server never answers', async () => {
    const { port } = silent.address() as AddressInfo;
    const client = new Redis({
      port,
      host: '127.0.0.1',
      maxRetriesPerRequest: null,
      // No handshake: ready as soon as the socket connects, as a client is
      // when its server freezes (the server here never answers anything).
      protocol: 2,
      disableClientInfo: true,
      enableReadyCheck: false,
    });
    client.on('error', () => undefined);
    await once(client, 'ready');
    expect(await redisResponds(client, 200)).toBe(false);

    const started = Date.now();
    await closeRedis(client, 200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
    // The socket closes (asynchronously) instead of waiting for a reply.
    if (client.status !== 'end') {
      await once(client, 'end');
    }
  });
});

const config = (values: Partial<RedisSettings> = {}): RedisSettings => ({
  url: 'redis://localhost:6379/2',
  password: undefined,
  sentinels: [],
  sentinelName: 'mymaster',
  prefix: 'app',
  ...values,
});

describe('connection settings', () => {
  it('takes the password of REDIS_PASSWORD over the URL, and TLS from rediss://', () => {
    const url = 'rediss://user:from-url@cache:6380/1';
    expect(redisOptions(config({ url }))).toMatchObject({
      host: 'cache',
      port: 6380,
      username: 'user',
      password: 'from-url',
      db: 1,
      tls: {},
    });
    expect(redisOptions(config({ url, password: 'from-file' })).password).toBe(
      'from-file',
    );
  });

  it('connects through Sentinel when sentinels are set', () => {
    const options = redisOptions(
      config({ sentinels: ['s1:26380', 's2'], sentinelName: 'main' }),
    );
    expect(options).toMatchObject({
      name: 'main',
      sentinels: [
        { host: 's1', port: 26380 },
        { host: 's2', port: 26379 },
      ],
    });
    expect(options.host).toBeUndefined();
  });
});

describe('a producer connection with Redis unreachable', () => {
  it('rejects at once and sends nothing when Redis returns', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');

    const client = new Redis({
      ...producerRedisOptions(config()),
      host: '127.0.0.1',
      port,
      retryStrategy: () => 50,
      lazyConnect: false,
    });
    client.on('error', () => undefined);
    const started = Date.now();
    // The add of an abandoned request: not buffered offline.
    await expect(client.set('job', '1')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);

    // Redis comes back: the rejected command must not arrive.
    const received: string[] = [];
    const returned = createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk.toString()));
    });
    returned.listen(port, '127.0.0.1');
    await once(returned, 'listening');
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.disconnect();
    returned.close();
    expect(received.join('')).not.toContain('job');
  });
});

describe('the producer connection reconnects quickly', () => {
  it('waits 50 ms before the first retry, with the production options', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    // Only host and port are the test's: retryStrategy is the production one.
    const client = new Redis({
      ...producerRedisOptions(config()),
      host: '127.0.0.1',
      port,
    });
    client.on('error', () => undefined);
    const delay = await new Promise<number>((resolve) =>
      client.once('reconnecting', resolve),
    );
    client.disconnect();
    expect(delay).toBe(50);
  });
});

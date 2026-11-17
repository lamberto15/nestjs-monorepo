import { Injectable } from '@nestjs/common';
import {
  ReadinessCheck,
  type ReadinessIndicator,
} from '../health/readiness.js';
import { RedisService } from './redis.service.js';

@Injectable()
@ReadinessCheck('redis')
export class RedisReadiness implements ReadinessIndicator {
  constructor(private readonly redis: RedisService) {}

  async check() {
    if (!(await this.redis.ping())) {
      throw new Error('Redis does not answer');
    }
  }
}

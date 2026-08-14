import { TokenBucket } from "../services/tokenBucket";
import { redisClient } from "../config/redis";


export interface ClientConfig {
  capacity: number;
  refillRatePerSec: number;
}

const buckets = new Map<string, TokenBucket>();
const clientConfigs = new Map<string, ClientConfig>();

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_RATE = 1;

export function getBucketForClient(clientKey: string): TokenBucket {
  if (!buckets.has(clientKey)) {
    const config = clientConfigs.get(clientKey);
    const capacity = config?.capacity ?? DEFAULT_CAPACITY;
    const refillRate = config?.refillRatePerSec ?? DEFAULT_REFILL_RATE;
    buckets.set(clientKey, new TokenBucket(capacity, refillRate));
  }
  return buckets.get(clientKey)!;
}

export function setClientConfig(clientKey: string, capacity: number, refillRatePerSec: number): void {
  clientConfigs.set(clientKey, { capacity, refillRatePerSec });

  const existingBucket = buckets.get(clientKey);
  if (existingBucket) {
    existingBucket.updateConfig(capacity, refillRatePerSec);
  }
}

async function saveBucketState(clientKey: string, state: BucketState): Promise<void> {
  const key = `bucket:${clientKey}`;

  await redisClient.hSet(key, {
    tokens: state.tokens.toString(),
    lastRefillTimeStamp: state.lastRefillTimeStamp.toString(),
    capacity: state.capacity.toString(),
    refillRatePerSec: state.refillRatePerSec.toString(),
  });
}

interface BucketState {
  tokens: number;
  lastRefillTimeStamp: number;
  capacity: number;
  refillRatePerSec: number;
}
async function getBucketState(clientKey: string): Promise<BucketState> {
  const key = `bucket:${clientKey}`;
  const data = await redisClient.hGetAll(key);
  if (Object.keys(data).length === 0) {
    // no bucket exists yet — check for admin config, or fall back to defaults
    const config = await redisClient.hGetAll(`config:${clientKey}`);
    const capacity = config.capacity ? Number(config.capacity) : DEFAULT_CAPACITY;
    const refillRatePerSec = config.refillRatePerSec ? Number(config.refillRatePerSec) : DEFAULT_REFILL_RATE;
    return {
      tokens: capacity,
      lastRefillTimeStamp: Date.now(),
      capacity,
      refillRatePerSec,
    };
  }
  return {
    tokens: Number(data.tokens),
    lastRefillTimeStamp: Number(data.lastRefillTimeStamp),
    capacity: Number(data.capacity),
    refillRatePerSec: Number(data.refillRatePerSec),
  };
}




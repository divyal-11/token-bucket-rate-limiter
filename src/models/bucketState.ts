import { TokenBucket } from "../services/tokenBucket";

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

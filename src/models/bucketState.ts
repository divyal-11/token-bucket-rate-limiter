import { redisClient } from "../config/redis";

// ─── Interfaces ───────────────────────────────────────────────────────────────

// Shape of the per-client config set by the admin endpoint (POST /admin/limits)
export interface ClientConfig {
  capacity: number;
  refillRatePerSec: number;
}

// Shape of the bucket state we persist in Redis.
// These 4 numbers are everything needed to fully recreate a bucket's position —
// no class instance needed, just plain data stored as a Redis Hash.
interface BucketState {
  tokens: number;              // how many tokens are currently available
  lastRefillTimeStamp: number; // when was the last refill calculated (ms since epoch)
  capacity: number;            // max tokens the bucket can hold (burst size)
  refillRatePerSec: number;    // how fast tokens refill (tokens per second)
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

// Fallback values used when no admin config has been set for a client
const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_RATE = 1;

// ─── Admin Config (Phase 3 → Redis) ──────────────────────────────────────────

// Called by POST /admin/limits to update a client's rate-limit settings.
// Does two things:
//   1. Always persists the new config to Redis (key: "config:{clientKey}")
//      so future first-time buckets for this client use the right settings.
//   2. If a bucket already exists for this client, settles its tokens under
//      the OLD rate before switching to the new capacity/rate — same logic
//      as TokenBucket.updateConfig(), just operating on plain Redis data.
export async function setClientConfig(
  clientKey: string,
  capacity: number,
  refillRatePerSec: number
): Promise<void> {
  // Step 1: Save the new config to Redis under "config:{clientKey}"
  // This ensures any NEW bucket created for this client picks up these settings
  await redisClient.hSet(`config:${clientKey}`, {
    capacity: capacity.toString(),
    refillRatePerSec: refillRatePerSec.toString(),
  });

  // Step 2: Check if a live bucket already exists for this client in Redis
  const bucketKey = `bucket:${clientKey}`;
  const existingData = await redisClient.hGetAll(bucketKey);

  if (Object.keys(existingData).length === 0) {
    // No existing bucket — nothing more to do right now.
    // The next /check request will create a fresh bucket using the config above.
    return;
  }

  // Step 3: A live bucket exists — we need to update it in place.
  // First, reconstruct the current bucket state from Redis strings
  const oldState: BucketState = {
    tokens: Number(existingData.tokens),
    lastRefillTimeStamp: Number(existingData.lastRefillTimeStamp),
    capacity: Number(existingData.capacity),
    refillRatePerSec: Number(existingData.refillRatePerSec),
  };

  // Settle (refill) under the OLD rate before switching config.
  // Why? So the client doesn't lose tokens they legitimately earned
  // under the previous rate before we change the rules on them.
  const now = Date.now();
  const secondsPassed = (now - oldState.lastRefillTimeStamp) / 1000;
  const tokensToAdd = Math.floor(secondsPassed * oldState.refillRatePerSec);
  const settledTokens = Math.min(oldState.capacity, oldState.tokens + tokensToAdd);

  // Build the new state with the updated capacity and rate.
  // Clamp tokens to the new capacity in case it was reduced.
  const newState: BucketState = {
    tokens: Math.min(settledTokens, capacity), // can't exceed the new cap
    lastRefillTimeStamp: now,
    capacity,
    refillRatePerSec,
  };

  // Persist the updated state back to Redis
  await saveBucketState(clientKey, newState);
}

// ─── Redis persistence helpers (Phase 4) ─────────────────────────────────────

// READ: Loads the bucket state for a client from Redis.
// Called at the START of every /check request before consuming a token.
//
// Two outcomes:
//   Case 1 — Bucket EXISTS in Redis → parse strings back to numbers and return
//             (client has been seen before, state survives restarts)
//
//   Case 2 — Bucket NOT found → client is new (or Redis was wiped)
//             → check if admin set a config for them (key: "config:{clientKey}")
//             → if yes, use those values; if no, use DEFAULT_CAPACITY / DEFAULT_REFILL_RATE
//             → return a brand-new full bucket (tokens = capacity)
async function getBucketState(clientKey: string): Promise<BucketState> {
  const key = `bucket:${clientKey}`;

  // hGetAll fetches all fields of the Redis Hash as a plain JS object.
  // Returns {} if the key does not exist in Redis.
  const data = await redisClient.hGetAll(key);

  if (Object.keys(data).length === 0) {
    // No saved bucket found for this client
    // Check if an admin config was set for them
    const config = await redisClient.hGetAll(`config:${clientKey}`);

    // Use admin-set values if they exist, otherwise fall back to defaults
    const capacity = config.capacity ? Number(config.capacity) : DEFAULT_CAPACITY;
    const refillRatePerSec = config.refillRatePerSec
      ? Number(config.refillRatePerSec)
      : DEFAULT_REFILL_RATE;

    // Return a fresh, full bucket — tokens start at max capacity
    return {
      tokens: capacity,
      lastRefillTimeStamp: Date.now(),
      capacity,
      refillRatePerSec,
    };
  }

  // Bucket found — Redis stores everything as strings, so parse back to numbers
  return {
    tokens: Number(data.tokens),
    lastRefillTimeStamp: Number(data.lastRefillTimeStamp),
    capacity: Number(data.capacity),
    refillRatePerSec: Number(data.refillRatePerSec),
  };
}

// WRITE: Saves the current bucket state to Redis as a Hash.
// Redis key format: "bucket:{clientKey}"  e.g. "bucket:alice"
//
// Why a Hash (hSet)? Each field is stored individually, making it easy to
// inspect or update specific fields. Alternative was a JSON string, but
// Hashes are more Redis-idiomatic for structured data.
//
// Why .toString()? Redis stores all values as strings internally.
// We convert numbers to strings here, and parse them back in getBucketState.
async function saveBucketState(clientKey: string, state: BucketState): Promise<void> {
  const key = `bucket:${clientKey}`;

  await redisClient.hSet(key, {
    tokens: state.tokens.toString(),
    lastRefillTimeStamp: state.lastRefillTimeStamp.toString(),
    capacity: state.capacity.toString(),
    refillRatePerSec: state.refillRatePerSec.toString(),
  });
}

// ─── Core rate-limit operation (Phase 4 Read-Modify-Write) ───────────────────

// The main function called by GET /check.
// Implements the full Read → Modify → Write cycle against Redis:
//
//   1. READ   — load current bucket state from Redis (getBucketState)
//   2. MODIFY — apply refill logic, then try to consume 1 token (in memory)
//   3. WRITE  — persist the updated state back to Redis (saveBucketState)
//
// Returns true (ALLOW) if a token was consumed, false (DENY) if bucket was empty.
//
// NOTE: This is NOT yet concurrency-safe. Two simultaneous requests for the
// same clientKey can both read "1 token left" and both return ALLOW.
// That race condition is fixed in Phase 5 using an atomic Redis Lua script.
export async function tryConsumeToken(clientKey: string): Promise<boolean> {
  // Step 1: READ — fetch the latest bucket state from Redis
  const state = await getBucketState(clientKey);

  // Step 2a: REFILL — calculate how many tokens have accumulated since last check.
  // Uses the same lazy-refill math as the original TokenBucket class,
  // but operates on plain BucketState data instead of a class instance.
  const now = Date.now();
  const secondsPassed = (now - state.lastRefillTimeStamp) / 1000;
  const tokensToAdd = Math.floor(secondsPassed * state.refillRatePerSec);
  state.tokens = Math.min(state.capacity, state.tokens + tokensToAdd); // cap at max
  state.lastRefillTimeStamp = now; // reset the refill clock

  // Step 2b: CONSUME — take 1 token if available
  let allowed = false;
  if (state.tokens >= 1) {
    state.tokens -= 1; // spend the token
    allowed = true;    // request is allowed
  }
  // if tokens < 1, allowed stays false → request is denied

  // Step 3: WRITE — persist the new state (whether allowed or denied)
  // This ensures the spent token and updated timestamp survive a restart
  await saveBucketState(clientKey, state);

  return allowed; // true = ALLOW, false = DENY
}

import { redisClient } from "../config/redis";
import * as fs from "fs";
import * as path from "path";

// ─── Interfaces ───────────────────────────────────────────────────────────────

// Shape of the per-client config set by the admin endpoint (POST /admin/limits)
export interface ClientConfig {
  capacity: number;
  refillRatePerSec: number;
  // Which algorithm to use for this client
  // "token-bucket" (default) = burst-friendly, fills steadily over time
  // "sliding-window"         = stricter, counts exact requests in last N seconds
  mode: "token-bucket" | "sliding-window";
  windowSizeMs?: number;  // only for sliding-window: how long the window lasts (ms)
  windowLimit?: number;   // only for sliding-window: max requests allowed per window
}

// Result returned by tryConsumeToken — used to set X-RateLimit-* response headers.
// Both token-bucket and sliding-window modes return this same shape.
export interface RateLimitResult {
  allowed: boolean;    // true = ALLOW, false = DENY
  remaining: number;   // requests/tokens left after this one
  limit: number;       // max allowed (capacity or windowLimit)
  resetAt: number;     // ms timestamp when the limit resets or next slot opens
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
  refillRatePerSec: number,
  mode: "token-bucket" | "sliding-window" = "token-bucket",
  windowSizeMs?: number,  // optional: explicit window duration for sliding-window mode
  windowLimit?: number    // optional: explicit request limit for sliding-window mode
): Promise<void> {
  // Step 1: Save the new config to Redis under "config:{clientKey}"
  const configFields: Record<string, string> = {
    capacity: capacity.toString(),
    refillRatePerSec: refillRatePerSec.toString(),
    mode,
  };

  // Only store sliding-window fields if they were explicitly provided
  if (windowSizeMs !== undefined) configFields.windowSizeMs = windowSizeMs.toString();
  if (windowLimit  !== undefined) configFields.windowLimit  = windowLimit.toString();

  await redisClient.hSet(`config:${clientKey}`, configFields);

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

// ─── Phase 5: Token Bucket Lua Script ────────────────────────────────────────

// Load the token bucket Lua script from file. Loaded once at startup.
// Features atomic lazy refill with sub-millisecond precision.
const CONSUME_TOKEN_SCRIPT = fs.readFileSync(
  path.join(__dirname, "../scripts/tokenBucket.lua"),
  "utf-8"
);

// ─── Phase 6: Sliding Window Lua Script ──────────────────────────────────────

// Load the sliding window Lua script from file.
// Uses a Redis Sorted Set of timestamps instead of a token counter.
const SLIDING_WINDOW_SCRIPT = fs.readFileSync(
  path.join(__dirname, "../scripts/slidingWindow.lua"),
  "utf-8"
);

// Exported so it can be called directly if needed (e.g. for testing).
// Takes explicit windowSizeMs and limit so the caller decides the parameters —
// no hidden Redis reads inside this function.
export async function tryConsumeSlidingWindow(
  clientKey: string,
  windowSizeMs: number,
  limit: number
): Promise<RateLimitResult> {
  const windowKey = `window:${clientKey}`;
  const now = Date.now();

  // Lua returns a 4-element array: [allowed, remaining, limit, resetAt_ms]
  const raw = await redisClient.eval(SLIDING_WINDOW_SCRIPT, {
    keys: [windowKey],
    arguments: [
      now.toString(),           // ARGV[1] — current timestamp (ms)
      windowSizeMs.toString(),  // ARGV[2] — window duration (ms)
      limit.toString(),         // ARGV[3] — max requests per window
    ],
  }) as [number, number, number, number];

  return {
    allowed:   raw[0] === 1,
    remaining: raw[1],
    limit:     raw[2],
    resetAt:   raw[3],
  };
}

// ─── Main rate-limit dispatcher ───────────────────────────────────────────────

// Called by GET /check for every incoming request.
// Reads the client's mode from Redis config, then routes to the right algorithm:
//   "token-bucket"   → tokenBucket.lua   (Phase 5 atomic Lua script)
//   "sliding-window" → slidingWindow.lua (Phase 6 sorted-set approach)
//
// Returns a RateLimitResult with allowed + header metadata (remaining, limit, resetAt).
// Defaults to "token-bucket" if no mode has been set for this client.
export async function tryConsumeToken(clientKey: string): Promise<RateLimitResult> {
  const config = await redisClient.hGetAll(`config:${clientKey}`);
  const mode = config.mode ?? "token-bucket";

  if (mode === "sliding-window") {
    const capacity   = config.capacity         ? Number(config.capacity)         : DEFAULT_CAPACITY;
    const refillRate = config.refillRatePerSec ? Number(config.refillRatePerSec) : DEFAULT_REFILL_RATE;
    const windowSizeMs = config.windowSizeMs
      ? Number(config.windowSizeMs)
      : Math.round((capacity / refillRate) * 1000);
    const limit = config.windowLimit
      ? Number(config.windowLimit)
      : capacity;

    return tryConsumeSlidingWindow(clientKey, windowSizeMs, limit);
  }

  // Default: token-bucket (atomic Lua script)
  // Lua returns a 4-element array: [allowed, remaining, capacity, resetAt_ms]
  const raw = await redisClient.eval(CONSUME_TOKEN_SCRIPT, {
    keys: [`bucket:${clientKey}`, `config:${clientKey}`],
    arguments: [
      Date.now().toString(),
      DEFAULT_CAPACITY.toString(),
      DEFAULT_REFILL_RATE.toString(),
    ],
  }) as [number, number, number, number];

  return {
    allowed:   raw[0] === 1,
    remaining: raw[1],
    limit:     raw[2],
    resetAt:   raw[3],
  };
}



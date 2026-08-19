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

// ─── Core rate-limit operation (Phase 5 — Atomic Lua Script) ─────────────────

// This Lua script runs ENTIRELY INSIDE Redis as one atomic operation.
// Redis is single-threaded — while a Lua script is running, no other
// Redis command can execute. This eliminates the race condition from Phase 4.
//
// The script does the full refill + consume + save cycle in one shot:
//   KEYS[1] = "bucket:{clientKey}"   — where the bucket state lives
//   KEYS[2] = "config:{clientKey}"   — where admin config lives (if set)
//   ARGV[1] = current timestamp (ms) — passed from Node.js
//   ARGV[2] = default capacity        — fallback if no config/bucket exists
//   ARGV[3] = default refill rate     — fallback if no config/bucket exists
//
// Returns: 1 = ALLOW (token consumed), 0 = DENY (bucket empty)
const CONSUME_TOKEN_SCRIPT = `
local bucketKey = KEYS[1]
local configKey = KEYS[2]
local now       = tonumber(ARGV[1])
local defCap    = tonumber(ARGV[2])
local defRate   = tonumber(ARGV[3])

-- Step 1: READ the bucket state from Redis
local data = redis.call('HGETALL', bucketKey)

local tokens, lastTS, capacity, refillRate

if #data == 0 then
  -- No bucket exists yet for this client.
  -- Check if the admin set a custom config for them.
  local cfg = redis.call('HGETALL', configKey)
  if #cfg == 0 then
    -- No admin config either — use defaults
    capacity   = defCap
    refillRate = defRate
  else
    -- Parse the config hash (HGETALL returns [key, val, key, val, ...])
    for i = 1, #cfg, 2 do
      if cfg[i] == 'capacity'        then capacity   = tonumber(cfg[i+1]) end
      if cfg[i] == 'refillRatePerSec' then refillRate = tonumber(cfg[i+1]) end
    end
  end
  -- Fresh bucket starts completely full
  tokens = capacity
  lastTS = now
else
  -- Bucket found — parse its fields
  for i = 1, #data, 2 do
    if data[i] == 'tokens'              then tokens     = tonumber(data[i+1]) end
    if data[i] == 'lastRefillTimeStamp' then lastTS     = tonumber(data[i+1]) end
    if data[i] == 'capacity'            then capacity   = tonumber(data[i+1]) end
    if data[i] == 'refillRatePerSec'    then refillRate = tonumber(data[i+1]) end
  end
end

-- Step 2a: REFILL — add tokens based on time elapsed since last check
local secondsPassed = (now - lastTS) / 1000
local tokensToAdd   = math.floor(secondsPassed * refillRate)
tokens = math.min(capacity, tokens + tokensToAdd)
lastTS = now

-- Step 2b: CONSUME — take 1 token if available
local allowed = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
end

-- Step 3: WRITE — save the updated state back to Redis
redis.call('HSET', bucketKey,
  'tokens',              tostring(tokens),
  'lastRefillTimeStamp', tostring(lastTS),
  'capacity',            tostring(capacity),
  'refillRatePerSec',    tostring(refillRate)
)

-- Return 1 = ALLOW, 0 = DENY
return allowed
`;

// Called by GET /check for every incoming request.
// Runs the Lua script atomically — the entire read+refill+consume+write
// happens as ONE indivisible Redis operation. No other request can
// interleave between the read and the write, so the race condition is gone.
export async function tryConsumeToken(clientKey: string): Promise<boolean> {
  const result = await redisClient.eval(CONSUME_TOKEN_SCRIPT, {
    keys: [`bucket:${clientKey}`, `config:${clientKey}`],
    arguments: [
      Date.now().toString(),           // ARGV[1] — current time
      DEFAULT_CAPACITY.toString(),     // ARGV[2] — default capacity
      DEFAULT_REFILL_RATE.toString(),  // ARGV[3] — default refill rate
    ],
  });

  // Lua returns 1 (ALLOW) or 0 (DENY) — cast to boolean
  return result === 1;
}


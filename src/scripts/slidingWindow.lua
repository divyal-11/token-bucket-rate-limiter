-- Sliding Window Rate Limiter — Atomic Lua Script
-- Runs entirely inside Redis as one uninterruptible operation.
--
-- KEYS[1] = "window:{clientKey}"   — sorted set of request timestamps
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = window size in ms      (e.g. 5000 = 5 second window)
-- ARGV[3] = max requests per window (the limit)
--
-- Returns an array: { allowed, remaining, limit, resetAt_ms }
--   allowed   = 1 (ALLOW) or 0 (DENY)
--   remaining = requests still available in this window AFTER this request
--   limit     = the configured max requests per window
--   resetAt   = ms timestamp when the oldest entry leaves the window

local windowKey    = KEYS[1]
local now          = tonumber(ARGV[1])
local windowSizeMs = tonumber(ARGV[2])
local limit        = tonumber(ARGV[3])

local windowStart = now - windowSizeMs

-- Step 1: PRUNE — remove all entries older than the window start
redis.call("ZREMRANGEBYSCORE", windowKey, "-inf", windowStart)

-- Step 2: COUNT — how many requests are in the current window?
local count = redis.call("ZCARD", windowKey)

-- Step 3: ALLOW or DENY
local allowed = 0
if count < limit then
  -- Record this request's timestamp as a unique sorted set member.
  -- Appending math.random() prevents duplicate-member collisions if two
  -- requests arrive at the exact same millisecond.
  redis.call("ZADD", windowKey, now, now .. "-" .. math.random())
  allowed = 1
end

-- Step 4: PEXPIRE — auto-delete key after a full window of inactivity
redis.call("PEXPIRE", windowKey, windowSizeMs)

-- Step 5: Calculate remaining requests in this window
local remaining
if allowed == 1 then
  remaining = limit - count - 1  -- we just consumed one slot
else
  remaining = 0                  -- already at/over limit
end

-- Step 6: Calculate resetAt — when does the OLDEST entry leave the window?
-- The oldest entry is at index 0 in the sorted set (lowest score = earliest timestamp).
-- Once it ages out, one more request slot opens up.
local oldest = redis.call("ZRANGE", windowKey, 0, 0, "WITHSCORES")
local resetAt
if #oldest > 0 then
  resetAt = tonumber(oldest[2]) + windowSizeMs  -- oldest_ts + window = when it expires
else
  resetAt = now + windowSizeMs  -- empty window, resets after a full window duration
end

-- Return array: { allowed, remaining, limit, resetAt_ms }
return { allowed, remaining, limit, resetAt }

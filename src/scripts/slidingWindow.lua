-- Sliding Window Rate Limiter — Atomic Lua Script
-- Runs entirely inside Redis as one uninterruptible operation.
--
-- HOW IT WORKS:
-- Instead of a bucket of tokens, we keep a Redis Sorted Set of timestamps.
-- Each request that gets ALLOWED adds its timestamp as an entry.
-- On every request, we first prune entries older than the window,
-- then count what's left. If count < limit → ALLOW, else → DENY.
--
-- This gives a TRUE sliding window — not a fixed 1s slot, but a rolling
-- "last N seconds" window that moves with real time.
--
-- KEYS[1] = sliding window key  e.g. "window:alice"
-- ARGV[1] = current timestamp in ms  (Date.now() from Node.js)
-- ARGV[2] = window size in ms  (e.g. 10000 for a 10-second window)
-- ARGV[3] = max requests allowed per window  (the rate limit)
--
-- Returns: 1 = ALLOW, 0 = DENY

local windowKey    = KEYS[1]
local now          = tonumber(ARGV[1])
local windowSizeMs = tonumber(ARGV[2])
local limit        = tonumber(ARGV[3])

-- The start of the current window (anything before this is "aged out")
local windowStart = now - windowSizeMs

-- Step 1: PRUNE — remove all entries older than the window start.
-- ZREMRANGEBYSCORE removes all members with a score between -inf and windowStart.
-- Score = timestamp, so this drops all requests that happened before the window.
redis.call("ZREMRANGEBYSCORE", windowKey, "-inf", windowStart)

-- Step 2: COUNT — how many requests happened inside the current window?
-- ZCARD returns the number of members remaining in the sorted set after pruning.
local count = redis.call("ZCARD", windowKey)

local allowed = 0
if count < limit then
  -- Step 3: RECORD — log this request's timestamp into the sorted set.
  -- We use now as the score (for range queries) but need a UNIQUE member value.
  -- Why unique? Sorted Sets don't allow duplicate members — if two requests
  -- arrive in the exact same millisecond, the second ZADD would overwrite
  -- the first instead of adding a new entry. Appending math.random() ensures
  -- every entry is unique while the score (now) stays accurate for pruning.
  redis.call("ZADD", windowKey, now, now .. "-" .. math.random())
  allowed = 1
end

-- Step 4: PEXPIRE — set the key to auto-delete after windowSizeMs of inactivity.
-- Without this, Redis would hold the sorted set forever for silent clients.
-- PEXPIRE resets the TTL on every request, so the key only expires if the
-- client goes completely quiet for a full window duration.
redis.call("PEXPIRE", windowKey, windowSizeMs)

-- Return 1 = ALLOW, 0 = DENY
return allowed

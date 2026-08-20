-- Token Bucket: Atomic Refill + Consume Lua Script
-- Runs entirely inside Redis as one uninterruptible operation.
--
-- KEYS[1] = "bucket:{clientKey}"    — bucket state hash
-- KEYS[2] = "config:{clientKey}"    — admin config hash (may not exist)
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = default capacity
-- ARGV[3] = default refill rate (tokens per second)
--
-- Returns an array: { allowed, remaining, capacity, resetAt_ms }
--   allowed   = 1 (ALLOW) or 0 (DENY)
--   remaining = tokens left AFTER this request
--   capacity  = max tokens (the configured limit)
--   resetAt   = ms timestamp when the bucket will next gain a token

local bucketKey = KEYS[1]
local configKey = KEYS[2]
local now       = tonumber(ARGV[1])
local defCap    = tonumber(ARGV[2])
local defRate   = tonumber(ARGV[3])

-- Step 1: READ the bucket state from Redis
local data = redis.call('HGETALL', bucketKey)

local tokens, lastTS, capacity, refillRate

if #data == 0 then
  -- No bucket exists yet — check for admin config
  local cfg = redis.call('HGETALL', configKey)
  if #cfg == 0 then
    capacity   = defCap
    refillRate = defRate
  else
    for i = 1, #cfg, 2 do
      if cfg[i] == 'capacity'         then capacity   = tonumber(cfg[i+1]) end
      if cfg[i] == 'refillRatePerSec' then refillRate = tonumber(cfg[i+1]) end
    end
  end
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

-- Step 4: Calculate reset timestamp
-- "Reset" = when the next token will arrive (if bucket is not full)
-- If bucket is already full (or just became full), reset is now.
local msPerToken = math.ceil(1000 / refillRate)
local resetAt
if tokens < capacity then
  resetAt = now + msPerToken  -- next token arrives in 1/refillRate seconds
else
  resetAt = now               -- already full, no wait
end

-- Return array: { allowed, remaining, limit, resetAt_ms }
return { allowed, tokens, capacity, resetAt }

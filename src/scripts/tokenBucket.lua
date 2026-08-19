-- Token Bucket: Atomic Refill + Consume Lua Script
-- Runs entirely inside Redis as one uninterruptible operation.
--
-- KEYS[1] = "bucket:{clientKey}"    — bucket state hash
-- KEYS[2] = "config:{clientKey}"    — admin config hash (may not exist)
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = default capacity
-- ARGV[3] = default refill rate (tokens per second)
--
-- Returns: 1 = ALLOW (token consumed), 0 = DENY (bucket empty)

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
      if cfg[i] == 'capacity'         then capacity   = tonumber(cfg[i+1]) end
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

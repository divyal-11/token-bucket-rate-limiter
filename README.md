# Distributed Token Bucket and Sliding Window Rate Limiter

A high-performance, concurrency-safe, networked rate-limiting service built with **Node.js**, **TypeScript**, **Express**, and **Redis**. Designed as an independent infrastructure service that upstream microservices call to enforce per-client traffic limits.

---

## Performance Benchmarks (autocannon)

- **Throughput:** ~7,800 – 7,900 requests/second
- **Average Latency:** 1.00 ms (p99: 1–2 ms)
- **Concurrency Correctness:** 100 simultaneous requests on `capacity=1` resulted in **exactly 1 ALLOW (200)** and **99 DENY (429)** (0 race condition double-spends).

---

## Architecture and Data Flow

```
   [ Client Request ]
           │
           ▼
┌───────────────────────┐
│     Express API       │  GET /check?clientKey=alice
│ (RateLimitController) │
└──────────┬────────────┘
           │ Reads config:{clientKey} -> determines mode
           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Redis Engine (Atomic)                    │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Mode: "token-bucket" (tokenBucket.lua)              │   │
│   │ • Key: bucket:{clientKey} (Hash)                    │   │
│   │ • Lazy time-based refill: tokensToAdd = Δt × rate   │   │
│   │ • Atomic decrement & return metadata                │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Mode: "sliding-window" (slidingWindow.lua)          │   │
│   │ • Key: window:{clientKey} (Sorted Set / ZSET)       │   │
│   │ • ZREMRANGEBYSCORE: prune timestamps < (now - window)│  │
│   │ • ZCARD: count recent requests                      │   │
│   │ • ZADD: record timestamp if count < limit           │   │
│   └─────────────────────────────────────────────────────┘   │
└──────────┬──────────────────────────────────────────────────┘
           │ Returns: [allowed, remaining, limit, resetAt]
           ▼
┌───────────────────────┐
│   Response + Headers  │  HTTP 200 (ALLOW) or HTTP 429 (DENY)
│                       │  X-RateLimit-Limit, X-RateLimit-Remaining,
│                       │  X-RateLimit-Reset, Retry-After
└───────────────────────┘
```

---

## Key Features

1. **Dual Algorithm Support (Per-Client Selection):**
   - **Token Bucket:** Allows controlled bursts up to `capacity`, steadily refilling at `refillRatePerSec`.
   - **Sliding Window:** Strict rolling-time enforcement using Redis Sorted Sets (`ZSET`), eliminating burst abuse.
2. **True Concurrency Safety (Atomic Lua Scripts):**
   - Read-Modify-Write cycle executed as an indivisible Redis Lua script (`EVAL`), eliminating race conditions under parallel traffic.
3. **Lazy Refill (No Background Cron / Timers):**
   - Refills calculated on-demand during request arrival ($\Delta t = \text{now} - \text{lastRefillTimeStamp}$).
4. **Clean Separation of Config vs. State:**
   - `config:{clientKey}`: Admin-defined settings (`capacity`, `refillRatePerSec`, `mode`, `windowSizeMs`, `windowLimit`).
   - `bucket:{clientKey}` / `window:{clientKey}`: Live, high-churn runtime state.
5. **Standard RFC Rate-Limit Headers:**
   - Sends `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response, plus `Retry-After` on `429 Too Many Requests`.
6. **Graceful Admin Reconfiguration:**
   - When updating client limits, existing buckets settle earned tokens under the *old* rate before applying the *new* rate.

---

## Quickstart and Setup

### Prerequisites
- Node.js (v18+ or v24+)
- Docker (for Redis)

### 1. Start Redis
```powershell
docker run -d -p 6379:6379 --name redis redis
```

### 2. Install Dependencies
```powershell
npm install
```

### 3. Environment Variables (Optional)
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the Express server listens on |
| `REDIS_URL` | `redis://localhost:6379` | Connection URI for the Redis instance |

### 4. Start Development Server (with hot-reload)
```powershell
npm run dev
```

Server will start on `http://localhost:3000`.

---

## API Reference

### 1. Check Rate Limit
Checks whether a request from a client is allowed or rate-limited.

- **URL:** `GET /check?clientKey=:clientKey`
- **Query Parameters:**
  - `clientKey` (string, required): Unique identifier for the client (e.g. user ID, API key, IP).

#### Response (Allowed — 200 OK)
```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1787209352
Content-Type: application/json

{
  "result": "ALLOW"
}
```

#### Response (Rate Limited — 429 Too Many Requests)
```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1787209353
Retry-After: 1
Content-Type: application/json

{
  "result": "DENY"
}
```

---

### 2. Update / Reconfigure Client Limits (Admin Endpoint)
Dynamically configures or updates rate-limiting rules, burst sizes, and algorithm modes for a specific client in real time.

- **URL:** `POST /admin/limits`
- **Headers:** `Content-Type: application/json`

#### Example A: Configure / Update Token Bucket
```bash
curl -X POST http://localhost:3000/admin/limits \
  -H "Content-Type: application/json" \
  -d '{
    "clientKey": "client-abc",
    "capacity": 20,
    "refillRatePerSec": 5,
    "mode": "token-bucket"
  }'
```

#### Example B: Configure / Update Sliding Window
```bash
curl -X POST http://localhost:3000/admin/limits \
  -H "Content-Type: application/json" \
  -d '{
    "clientKey": "client-xyz",
    "capacity": 10,
    "refillRatePerSec": 2,
    "mode": "sliding-window",
    "windowSizeMs": 60000,
    "windowLimit": 100
  }'
```

#### Response (200 OK)
```json
{
  "message": "Limits updated for client-xyz",
  "capacity": 10,
  "refillRatePerSec": 2,
  "mode": "sliding-window",
  "windowSizeMs": 60000,
  "windowLimit": 100
}
```

> **Note on Live Reconfiguration:** When updating an existing client's limits, the system automatically settles earned tokens under the *old* rate first, resets the timestamp clock, and clamps tokens to the new capacity so the client is never penalized or over-credited during live rule changes.

---

### 3. Health Check
Monitors service status and Redis connectivity.

- **URL:** `GET /health`

#### Response (200 OK)
```json
{
  "status": "UP",
  "redis": "CONNECTED",
  "timestamp": "2026-08-20T07:29:19.043Z"
}
```

---

## Testing and Validation

### Concurrency Race Test
Fires 20 simultaneous requests against a client configured with `capacity: 1`:
```powershell
npm run test:race
# Output: ALLOW: 1, DENY: 19
```

### Full Load Test Suite (autocannon)
Executes a multi-phase benchmark across both algorithms and validates 100-request atomicity:
```powershell
npm run test:load
```

Or run both test suites in one go:
```powershell
npm test
```

---

## Architectural and Design Decisions

### 1. Why Config vs. State Separation?
- **`config:{clientKey}`** stores admin settings (`capacity`, `mode`, etc.).
- **`bucket:{clientKey}`** stores volatile runtime counters (`tokens`, `lastRefillTimeStamp`).
- **Rationale:** Keeps high-frequency read/write data isolated from static config. Clearing or expiring a runtime bucket does not wipe the client's configured tier.

### 2. Why Redis Lua Scripts for Concurrency?
- In a naive Node.js implementation:
  1. `READ`: `HGETALL` tokens
  2. `MODIFY`: calculate refill & decrement in JS
  3. `WRITE`: `HSET` new tokens
- Under concurrent requests, two requests can read `tokens = 1` simultaneously before either writes back, resulting in a **double-spend**.
- **Lua Solution:** Redis is single-threaded. When `EVAL` runs a Lua script, the entire read-refill-consume-write cycle executes atomically with zero interleaving from other clients or threads.

### 3. Redis Sorted Sets (`ZSET`) in Sliding Window
- **`ZREMRANGEBYSCORE windowKey -inf (now - windowSizeMs)`**: Drops timestamps that aged out of the rolling window.
- **`ZCARD windowKey`**: Counts remaining active requests in the window.
- **`ZADD windowKey now (now .. "-" .. random())`**: Adds a unique member with timestamp score. Random suffix prevents collision when two requests arrive in the exact same millisecond.
- **`PEXPIRE windowKey windowSizeMs`**: Automatic TTL cleanup so inactive keys do not leak memory in Redis.

### 4. Token Bucket vs. Sliding Window Trade-Offs
| Factor | Token Bucket | Sliding Window |
|---|---|---|
| **Burst Allowance** | Allows bursts up to `capacity` | No bursts beyond window limit |
| **Refill Behavior** | Continuous, smooth refill ($\Delta t \times r$) | Rolling timestamp window |
| **Memory per Client** | Fixed $O(1)$ (single Hash with 4 fields) | $O(N)$ where $N$ is requests in window |
| **Best For** | General web APIs, burst-tolerant workloads | Financial transactions, strict DDoS mitigation |

---

## Repository Structure

```
├── src/
│   ├── config/
│   │   └── redis.ts              # Redis client connection and error handling
│   ├── controllers/
│   │   ├── adminController.ts    # POST /admin/limits handler and validation
│   │   └── rateLimitController.ts# GET /check handler and HTTP header builder
│   ├── models/
│   │   └── bucketState.ts        # Data access layer, dispatcher, and config logic
│   ├── routes/
│   │   ├── adminRoutes.ts        # Admin route definitions
│   │   └── rateLimitRoutes.ts    # Rate limit check route definitions
│   ├── scripts/
│   │   ├── tokenBucket.lua       # Atomic Token Bucket Lua script
│   │   └── slidingWindow.lua     # Atomic Sliding Window Lua script (ZSET)
│   ├── services/
│   │   └── tokenBucket.ts        # In-memory TokenBucket class (Phase 1)
│   ├── index.ts                  # Express server entrypoint
│   ├── racetest.ts               # Parallel concurrency race condition test
│   └── loadtest.ts               # Autocannon automated benchmark suite
├── package.json
└── tsconfig.json
```

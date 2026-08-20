# Token Bucket Rate Limiter — Project Blueprint

**Difficulty:** Beginner
**Stack:** Node.js + TypeScript + Express + Redis (in-memory first, Redis later)
**Source:** "5 Backend Projects Every GOAT Has Built" (Project 01)

---

## 1. What We're Building

A **standalone rate-limiting API** — not a feature bolted onto another app, but a networked service that other services call into to check whether a request should be allowed. This forces real engagement with shared state, clock precision, and concurrency, instead of just importing a rate-limit library.

---

## 2. Core Requirements (from spec — all must be met)

| # | Requirement |
|---|---|
| 1 | Endpoint that, given a client key, returns **ALLOW** or **DENY** based on token bucket algorithm |
| 2 | Per-client configurable limits (requests/sec, burst size) via an **admin endpoint** |
| 3 | State **survives a service restart** — persisted, not just in-memory |
| 4 | Concurrent requests for the **same client key** don't double-spend tokens (race-condition safe) |
| 5 | **Sliding-window mode** available as an alternative, selectable per client |
| 6 | Standard **rate-limit headers** on every response (limit, remaining, reset time) |
| 7 | **Load test** proving correctness under 500+ concurrent requests/sec |

### Stretch Goals
- Distributed mode: multiple limiter instances sharing state correctly
- Tiny live dashboard showing request/deny rates per client

### Skills This Project Builds
Concurrency control, atomic operations, algorithm design, API contract design, load testing.

---

## 3. Core Concept — Token Bucket Algorithm

- Each client has a **bucket** with a max **capacity** (burst size)
- Tokens **refill at a steady rate** (requests/sec)
- Each request tries to **consume 1 token**:
  - Token available → **ALLOW**, decrement
  - Bucket empty → **DENY**
- **Lazy refill**: don't run a background timer. Instead, calculate accumulated tokens *only when a request arrives*, based on elapsed time since last check — capped at `capacity` so idle clients can't hoard unlimited burst.

```
tokensToAdd = secondsPassed × refillRatePerSec
tokens = min(capacity, tokens + tokensToAdd)
```

---

## 4. Phased Build Plan

### Phase 1 — Pure Algorithm (no server) ✅
- [x] `TokenBucket` class: `capacity`, `tokens`, `refillRatePerSec`, `lastRefillTimestamp`
- [x] `refill()` — lazy, time-based, capped at capacity
- [x] `tryConsume()` — refill, then consume 1 token if available
- [x] Manual test: burst depletion (5 rapid calls → ALLOW, next 2 → DENY)
- [x] Manual test: refill over time (wait 3s → tokens replenish proportionally)

### Phase 2 — Wrap in an API ✅
- [x] Express server, single `GET /check?clientKey=...` endpoint
- [x] In-memory `Map<string, TokenBucket>` — one bucket per client key, created on first sight
- [x] Return `200 ALLOW` / `429 DENY`
- [x] Verify multiple sequential calls for the same client behave correctly
- [x] Understand *why* keyed-by-client-key matters (isolation: one client's usage never affects another client's bucket)

### Phase 3 — Admin Endpoint (per-client config) ✅
- [x] `POST /admin/limits` — set `{ clientKey, capacity, refillRatePerSec, mode }` for a specific client
- [x] Store per-client config separately from per-client bucket state
- [x] New clients without explicit config fall back to sane defaults
- [x] Validate input (reject negative/zero capacity or refill rate)

### Phase 4 — Persistence (Redis) ✅
- [x] Move bucket state out of the in-memory `Map` into Redis
- [x] Design key scheme: `bucket:{clientKey}` storing `{ tokens, lastRefillTimestamp, capacity, refillRatePerSec }` as a Redis Hash
- [x] On restart, buckets resume from Redis instead of resetting to full
- [x] Store configuration in `config:{clientKey}`

### Phase 5 — Concurrency Safety ✅
- [x] Identify the race: simultaneous requests both read before either writes
- [x] Fix using atomic Redis Lua script (`tokenBucket.lua`), eliminating the read-modify-write gap
- [x] Concurrency test (`racetest.ts`): fire 20/100 simultaneous requests, assert allowed count never exceeds capacity

### Phase 6 — Sliding Window Mode ✅
- [x] Implement sliding-window counter via Redis Sorted Set (`slidingWindow.lua`)
- [x] Per-client toggle: `mode: "token-bucket" | "sliding-window"` with optional `windowSizeMs` & `windowLimit`
- [x] Same `/check` endpoint routes to whichever mode the client is configured for

### Phase 7 — Response Headers ✅
- [x] Add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every `/check` response
- [x] Add `Retry-After` header on 429 DENY responses
- [x] Compute `Reset` correctly for both token-bucket and sliding-window modes

### Phase 8 — Load Testing ✅
- [x] Automated benchmarking suite using `autocannon` (`src/loadtest.ts`)
- [x] Tested 7,500+ req/sec across 10 concurrent connections
- [x] Verified 100-request parallel atomicity test (exactly 1 allowed on capacity=1)

### Phase 9 — Polish Pass (per our process) ⬅️ *Next*
- [ ] README: architecture diagram, setup instructions, API docs
- [ ] Design-decisions write-up: why token bucket vs sliding window, why lazy refill, how the race condition was solved, trade-offs of the Redis key scheme
- [ ] Demo & project wrap-up

---

## 5. Current Status

- **Stack:** Node.js, TypeScript, Express, Redis, autocannon
- **Phases 1–8:** Complete, fully tested, verified under 7,500+ req/sec load testing
- **Next Step:** Phase 9 — Polish Pass (comprehensive documentation, architecture diagrams, and design decisions writeup)

---

## 6. Open Questions to Resolve Along the Way

- Redis data structure choice for bucket state (Hash vs JSON string) — decide in Phase 4
- Whether admin-set limits should apply retroactively to an already-created bucket, or only to new buckets — decide in Phase 3
- Exact atomic mechanism for Phase 5 (Lua script vs WATCH/MULTI) — trade-offs to weigh when we get there
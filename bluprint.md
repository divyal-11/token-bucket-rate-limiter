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

### Phase 1 — Pure Algorithm (no server) ✅ *in progress*
- [x] `TokenBucket` class: `capacity`, `tokens`, `refillRatePerSec`, `lastRefillTimestamp`
- [x] `refill()` — lazy, time-based, capped at capacity
- [x] `tryConsume()` — refill, then consume 1 token if available
- [x] Manual test: burst depletion (5 rapid calls → ALLOW, next 2 → DENY)
- [x] Manual test: refill over time (wait 3s → tokens replenish proportionally)

### Phase 2 — Wrap in an API
- [x] Express server, single `GET /check?clientKey=...` endpoint
- [x] In-memory `Map<string, TokenBucket>` — one bucket per client key, created on first sight
- [x] Return `200 ALLOW` / `429 DENY`
- [ ] **Currently here** → verify multiple sequential calls for the same client behave correctly
- [ ] Understand *why* keyed-by-client-key matters (isolation: one client's usage never affects another client's bucket)

### Phase 3 — Admin Endpoint (per-client config)
- [ ] `POST /admin/limits` — set `{ clientKey, capacity, refillRatePerSec }` for a specific client
- [ ] Store per-client config separately from per-client bucket state
- [ ] New clients without explicit config fall back to sane defaults
- [ ] Validate input (reject negative/zero capacity or refill rate)

### Phase 4 — Persistence (Redis)
- [ ] Move bucket state out of the in-memory `Map` into Redis
- [ ] Design key scheme, e.g. `bucket:{clientKey}` storing `{ tokens, lastRefillTimestamp }`
- [ ] On restart, buckets resume from Redis instead of resetting to full
- [ ] Decide: store as Redis Hash vs JSON string (trade-offs — discuss before implementing)

### Phase 5 — Concurrency Safety
- [ ] Identify the race: two simultaneous requests for the same client both read "1 token left," both consume, bucket goes negative
- [ ] Fix using an **atomic operation** — Redis `Lua script` (EVAL) or `WATCH`/`MULTI` transaction, so refill+consume happens as one atomic unit
- [ ] Write a concurrency test: fire N simultaneous requests for one client key, assert allowed count never exceeds capacity

### Phase 6 — Sliding Window Mode
- [ ] Implement sliding-window counter as an alternative algorithm
- [ ] Per-client toggle: `mode: "token-bucket" | "sliding-window"` (set via admin endpoint)
- [ ] Same `/check` endpoint routes to whichever mode the client is configured for

### Phase 7 — Response Headers
- [ ] Add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every `/check` response
- [ ] Compute `Reset` correctly for both token-bucket and sliding-window modes

### Phase 8 — Load Testing
- [ ] Pick a tool (e.g. `autocannon`, `k6`, or a custom script)
- [ ] Simulate 500+ concurrent req/sec against `/check`
- [ ] Verify: no client ever exceeds their configured limit, no crashes, no incorrect double-allows

### Phase 9 — Polish Pass (per our process)
- [ ] README: architecture diagram, setup instructions, API docs
- [ ] Design-decisions write-up: why token bucket vs sliding window, why lazy refill, how the race condition was solved, trade-offs of the Redis key scheme
- [ ] Pick at least one stretch goal to implement: **distributed mode** (multiple limiter instances sharing Redis state correctly) recommended, since it previews concepts needed later for the Self-Healing Distributed Cache project
- [ ] Demo gif/video (optional but valuable)

---

## 5. Current Status

- **Stack confirmed:** Node 24.16.0, TypeScript 6.0.3 (pinned down from 7.0.2 due to `ts-node` incompatibility with TS7's new internals), Express, `redis` npm package
- **Phase 1:** Complete and verified — lazy refill algorithm understood and tested correctly
- **Phase 2:** In progress — Express `/check` endpoint built and running; next step is running repeated `curl` tests against it and confirming per-client isolation via the `Map<string, TokenBucket>` keying

---

## 6. Open Questions to Resolve Along the Way

- Redis data structure choice for bucket state (Hash vs JSON string) — decide in Phase 4
- Whether admin-set limits should apply retroactively to an already-created bucket, or only to new buckets — decide in Phase 3
- Exact atomic mechanism for Phase 5 (Lua script vs WATCH/MULTI) — trade-offs to weigh when we get there
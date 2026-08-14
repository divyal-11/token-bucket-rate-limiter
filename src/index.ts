class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillRatePerSec: number;
  private lastRefillTimeStamp: number;

  constructor(capacity: number, refillRatePerSec: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefillTimeStamp = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const secondsPassed = (now - this.lastRefillTimeStamp) / 1000;
    const tokensToAdd = Math.floor(secondsPassed * this.refillRatePerSec);

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTimeStamp = now;
  }

  public tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true; //allow
    }
    return false; //reject
  }

  public updateConfig(newCapacity: number, newRefillRate: number): void {
    this.refill(); // settle up under the OLD rate before changing anything
    this.capacity = newCapacity;
    this.refillRatePerSec = newRefillRate;
    this.tokens = Math.min(this.tokens, this.capacity); // clamp immediately
  }


}

import express from "express";

const app = express();
const PORT = 3000;

// in-memory store: client key -> their bucket
const buckets = new Map<string, TokenBucket>();

interface ClientConfig {
  capacity: number;
  refillRatePerSec: number;
}

const clientConfigs = new Map<string, ClientConfig>();

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_RATE = 1; // tokens per second

function getBucketForClient(clientKey: string): TokenBucket {
  if (!buckets.has(clientKey)) {
    const config = clientConfigs.get(clientKey);
    const capacity = config?.capacity ?? DEFAULT_CAPACITY;
    const refillRate = config?.refillRatePerSec ?? DEFAULT_REFILL_RATE;
    buckets.set(clientKey, new TokenBucket(capacity, refillRate));
  }
  return buckets.get(clientKey)!;
}

app.use(express.json()); // needed to parse JSON request bodies

app.get("/check", (req, res) => {
  const clientKey = req.query.clientKey as string;

  if (!clientKey) {
    return res.status(400).json({ error: "clientKey query param is required" });
  }

  const bucket = getBucketForClient(clientKey);
  const allowed = bucket.tryConsume();

  if (allowed) {
    res.status(200).json({ result: "ALLOW" });
  } else {
    res.status(429).json({ result: "DENY" });
  }
});



app.post("/admin/limits", (req, res) => {
  const { clientKey, capacity, refillRatePerSec } = req.body;

  if (!clientKey || typeof capacity !== "number" || typeof refillRatePerSec !== "number") {
    return res.status(400).json({ error: "clientKey, capacity, and refillRatePerSec are required" });
  }

  if (capacity <= 0 || refillRatePerSec <= 0) {
    return res.status(400).json({ error: "capacity and refillRatePerSec must be positive" });
  }

  clientConfigs.set(clientKey, { capacity, refillRatePerSec });

  const existingBucket = buckets.get(clientKey);
  if (existingBucket) {
    existingBucket.updateConfig(capacity, refillRatePerSec);
  }

  res.status(200).json({ message: `Limits updated for ${clientKey}`, capacity, refillRatePerSec });
});

app.listen(PORT, () => {
  console.log(`Rate limiter service running on http://localhost:${PORT}`);
});
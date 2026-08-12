class TokenBucket{
    private capacity: number;
    private tokens: number;
    private refillRatePerSec: number;
    private lastRefillTimeStamp : number;

    constructor(capacity: number, refillRatePerSec: number){
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRatePerSec = refillRatePerSec;
        this.lastRefillTimeStamp = Date.now();
    }

    private refill():void{
        const now = Date.now();
        const secondsPassed = (now - this.lastRefillTimeStamp) /1000;
        const tokensToAdd = Math.floor(secondsPassed * this.refillRatePerSec);
    
        this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
        this.lastRefillTimeStamp = now;
    }

    public tryConsume():boolean{
        this.refill();

        if(this.tokens >=1){
            this.tokens -=1;
            return true; //allow
        }
        return false; //reject
    }

    
}

import express from "express";

const app = express();
const PORT = 3000;

// in-memory store: client key -> their bucket
const buckets = new Map<string, TokenBucket>();

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_RATE = 1; // tokens per second

function getBucketForClient(clientKey: string): TokenBucket {
  if (!buckets.has(clientKey)) {
    buckets.set(clientKey, new TokenBucket(DEFAULT_CAPACITY, DEFAULT_REFILL_RATE));
  }
  return buckets.get(clientKey)!;
}

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

app.listen(PORT, () => {
  console.log(`Rate limiter service running on http://localhost:${PORT}`);
});
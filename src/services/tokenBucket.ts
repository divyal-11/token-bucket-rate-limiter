export class TokenBucket {
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
      return true;
    }
    return false;
  }

  public updateConfig(newCapacity: number, newRefillRate: number): void {
    this.refill();
    this.capacity = newCapacity;
    this.refillRatePerSec = newRefillRate;
    this.tokens = Math.min(this.tokens, this.capacity);
  }
}

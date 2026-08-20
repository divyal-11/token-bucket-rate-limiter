import { Request, Response } from "express";
import { tryConsumeToken } from "../models/bucketState";

// Handles GET /check?clientKey=...
// Calls tryConsumeToken which returns a RateLimitResult with:
//   allowed, remaining, limit, resetAt
// These are used to set standard X-RateLimit-* response headers.
export async function checkRateLimit(req: Request, res: Response) {
  const clientKey = req.query.clientKey as string;

  if (!clientKey) {
    return res.status(400).json({ error: "clientKey query param is required" });
  }

  const result = await tryConsumeToken(clientKey);

  // ─── Set standard rate-limit headers on EVERY response ───────────────────
  //
  // X-RateLimit-Limit     — the max requests the client is allowed per window
  // X-RateLimit-Remaining — how many requests they have left right now
  // X-RateLimit-Reset     — Unix timestamp (seconds) when the limit resets
  //                         (Clients use this to know when to retry)
  //
  // resetAt comes from Lua in ms — divide by 1000 and floor for Unix seconds
  const resetAtSeconds = Math.floor(result.resetAt / 1000);

  res.set({
    "X-RateLimit-Limit":     result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset":     resetAtSeconds.toString(),
  });

  if (result.allowed) {
    res.status(200).json({ result: "ALLOW" });
  } else {
    // On 429, also send Retry-After — seconds until the client can retry.
    // This is the standard header for 429 responses (RFC 6585).
    const retryAfterSeconds = Math.max(0, resetAtSeconds - Math.floor(Date.now() / 1000));
    res.set("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({ result: "DENY" });
  }
}

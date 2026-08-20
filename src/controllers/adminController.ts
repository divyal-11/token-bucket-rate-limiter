import { Request, Response } from "express";
import { setClientConfig } from "../models/bucketState";

export async function updateLimits(req: Request, res: Response) {
  const { clientKey, capacity, refillRatePerSec, mode, windowSizeMs, windowLimit } = req.body;

  // Validate required fields
  if (!clientKey || typeof capacity !== "number" || typeof refillRatePerSec !== "number") {
    return res.status(400).json({ error: "clientKey, capacity, and refillRatePerSec are required" });
  }

  if (capacity <= 0 || refillRatePerSec <= 0) {
    return res.status(400).json({ error: "capacity and refillRatePerSec must be positive" });
  }

  // Validate mode if provided
  if (mode !== undefined && mode !== "token-bucket" && mode !== "sliding-window") {
    return res.status(400).json({ error: "mode must be \"token-bucket\" or \"sliding-window\"" });
  }

  // windowSizeMs and windowLimit are optional — only used for sliding-window mode
  if (windowSizeMs !== undefined && (typeof windowSizeMs !== "number" || windowSizeMs <= 0)) {
    return res.status(400).json({ error: "windowSizeMs must be a positive number (milliseconds)" });
  }

  if (windowLimit !== undefined && (typeof windowLimit !== "number" || windowLimit <= 0)) {
    return res.status(400).json({ error: "windowLimit must be a positive number" });
  }

  await setClientConfig(clientKey, capacity, refillRatePerSec, mode, windowSizeMs, windowLimit);

  res.status(200).json({
    message: `Limits updated for ${clientKey}`,
    capacity,
    refillRatePerSec,
    mode: mode ?? "token-bucket",
    ...(windowSizeMs !== undefined && { windowSizeMs }),
    ...(windowLimit  !== undefined && { windowLimit }),
  });
}

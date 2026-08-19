import { Request, Response } from "express";
import { setClientConfig } from "../models/bucketState";

export async function updateLimits(req: Request, res: Response) {
  const { clientKey, capacity, refillRatePerSec, mode } = req.body;

  // Validate required fields
  if (!clientKey || typeof capacity !== "number" || typeof refillRatePerSec !== "number") {
    return res.status(400).json({ error: "clientKey, capacity, and refillRatePerSec are required" });
  }

  if (capacity <= 0 || refillRatePerSec <= 0) {
    return res.status(400).json({ error: "capacity and refillRatePerSec must be positive" });
  }

  // Validate mode if provided — must be one of the two known values
  if (mode !== undefined && mode !== "token-bucket" && mode !== "sliding-window") {
    return res.status(400).json({ error: "mode must be \"token-bucket\" or \"sliding-window\"" });
  }

  // mode defaults to "token-bucket" inside setClientConfig if not provided
  await setClientConfig(clientKey, capacity, refillRatePerSec, mode);

  res.status(200).json({
    message: `Limits updated for ${clientKey}`,
    capacity,
    refillRatePerSec,
    mode: mode ?? "token-bucket",
  });
}

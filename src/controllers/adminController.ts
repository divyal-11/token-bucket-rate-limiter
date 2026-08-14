import { Request, Response } from "express";
import { setClientConfig } from "../models/bucketState";

export function updateLimits(req: Request, res: Response) {
  const { clientKey, capacity, refillRatePerSec } = req.body;

  if (!clientKey || typeof capacity !== "number" || typeof refillRatePerSec !== "number") {
    return res.status(400).json({ error: "clientKey, capacity, and refillRatePerSec are required" });
  }

  if (capacity <= 0 || refillRatePerSec <= 0) {
    return res.status(400).json({ error: "capacity and refillRatePerSec must be positive" });
  }

  setClientConfig(clientKey, capacity, refillRatePerSec);

  res.status(200).json({ message: `Limits updated for ${clientKey}`, capacity, refillRatePerSec });
}

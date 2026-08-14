import { Request, Response } from "express";
import { getBucketForClient } from "../models/bucketState";

export function checkRateLimit(req: Request, res: Response) {
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
}

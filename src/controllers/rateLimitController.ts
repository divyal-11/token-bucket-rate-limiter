import { Request, Response } from "express";
import { tryConsumeToken } from "../models/bucketState";

// Handles GET /check?clientKey=...
// Calls tryConsumeToken which does the full Redis Read-Modify-Write cycle
export async function checkRateLimit(req: Request, res: Response) {
  const clientKey = req.query.clientKey as string;

  if (!clientKey) {
    return res.status(400).json({ error: "clientKey query param is required" });
  }

  // tryConsumeToken: reads state from Redis, refills, consumes 1 token, writes back
  const allowed = await tryConsumeToken(clientKey);

  if (allowed) {
    res.status(200).json({ result: "ALLOW" });
  } else {
    res.status(429).json({ result: "DENY" });
  }
}

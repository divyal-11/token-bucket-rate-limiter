import express, { Request, Response } from "express";
import { connectRedis, redisClient } from "./config/redis";
import rateLimitRoutes from "./routes/rateLimitRoutes";
import adminRoutes from "./routes/adminRoutes";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// ─── Health Check Endpoint ───────────────────────────────────────────────────
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const pong = await redisClient.ping();
    res.status(200).json({
      status: "UP",
      redis: pong === "PONG" ? "CONNECTED" : "DEGRADED",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "DOWN",
      redis: "DISCONNECTED",
      error: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── Application Routes ──────────────────────────────────────────────────────
app.use(rateLimitRoutes);
app.use(adminRoutes);

async function start() {
  await connectRedis();
  app.listen(PORT, () => {
    console.log(`Rate limiter service running on http://localhost:${PORT}`);
  });
}

start();
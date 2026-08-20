import { createClient } from "redis";

// Connect to REDIS_URL if specified in environment, or fall back to localhost
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redisClient = createClient({
  url: redisUrl,
});

redisClient.on("error", (err) => console.error("Redis error:", err));

export async function connectRedis() {
  await redisClient.connect();
  console.log(`Connected to Redis at ${redisUrl}`);
}

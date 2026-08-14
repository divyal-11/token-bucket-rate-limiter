import { createClient } from "redis";

export const redisClient = createClient();

redisClient.on("error", (err) => console.error("Redis error:", err));

export async function connectRedis() {
  await redisClient.connect();
  console.log("Connected to Redis");
}

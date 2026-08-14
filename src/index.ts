import express from "express";
import { connectRedis } from "./config/redis";
import rateLimitRoutes from "./routes/rateLimitRoutes";
import adminRoutes from "./routes/adminRoutes";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(rateLimitRoutes);
app.use(adminRoutes);

async function start() {
  await connectRedis();
  app.listen(PORT, () => {
    console.log(`Rate limiter service running on http://localhost:${PORT}`);
  });
}

start();
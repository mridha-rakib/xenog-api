import mongoose from "mongoose";
import { RedisClient } from "../../config/redis.js";

export class HealthService {
  public async check(): Promise<Record<string, unknown>> {
    const redis = RedisClient.getClient();
    const redisStatus = redis.status;

    return {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        api: "ok",
        mongodb: mongoose.connection.readyState === 1 ? "ok" : "down",
        redis: redisStatus,
      },
    };
  }
}

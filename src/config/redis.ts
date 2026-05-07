import Redis from "ioredis";
import { env } from "./env.js";
import { logger } from "../core/logger/logger.js";

export class RedisClient {
  private static client: Redis | null = null;

  public static connect(): Redis {
    if (this.client) {
      return this.client;
    }

    this.client = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      db: env.REDIS_DB,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.client.on("connect", () => {
      logger.info({ service: "redis" }, "Redis connected");
    });

    this.client.on("error", (error) => {
      logger.error({ service: "redis", error }, "Redis error");
    });

    return this.client;
  }

  public static getClient(): Redis {
    if (!this.client) {
      return this.connect();
    }

    return this.client;
  }

  public static async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.quit();
    this.client = null;
    logger.info({ service: "redis" }, "Redis disconnected");
  }
}

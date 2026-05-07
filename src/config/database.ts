import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../core/logger/logger.js";

export class Database {
  public static async connect(): Promise<void> {
    mongoose.set("strictQuery", true);

    await mongoose.connect(env.MONGODB_URI);
    logger.info({ database: "mongodb" }, "Database connected");
  }

  public static async disconnect(): Promise<void> {
    await mongoose.disconnect();
    logger.info({ database: "mongodb" }, "Database disconnected");
  }
}

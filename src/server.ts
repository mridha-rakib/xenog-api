import { createServer } from "node:http";
import { env } from "./config/env.js";
import { Database } from "./config/database.js";
import { MinioClient } from "./config/minio.js";
import { RedisClient } from "./config/redis.js";
import { logger } from "./core/logger/logger.js";
import { seedAdminUser } from "./core/seed/admin.seed.js";
import { RealtimeGateway } from "./modules/realtime/realtime.gateway.js";
import { createApp } from "./app.js";

const startServer = async (): Promise<void> => {
  await Database.connect();
  await seedAdminUser();
  await RedisClient.waitUntilReady();
  await MinioClient.ensureBucket();

  const app = createApp();
  const server = createServer(app);
  const realtimeGateway = new RealtimeGateway();

  realtimeGateway.attach(server);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, apiPrefix: env.API_PREFIX, wsPath: "/ws" }, "Server started");
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "Shutdown started");
    realtimeGateway.close();

    server.close(async () => {
      await RedisClient.disconnect();
      await Database.disconnect();
      logger.info("Shutdown completed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

void startServer().catch((error) => {
  logger.fatal({ error }, "Failed to start server");
  process.exit(1);
});

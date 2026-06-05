import { Database } from "../config/database.js";
import { logger } from "../core/logger/logger.js";
import { seedAdminUser } from "../core/seed/admin.seed.js";

const run = async (): Promise<void> => {
  await Database.connect();
  await seedAdminUser();
  await Database.disconnect();
};

void run().catch(async (error) => {
  logger.fatal({ error }, "Failed to seed admin user");
  await Database.disconnect().catch(() => undefined);
  process.exit(1);
});

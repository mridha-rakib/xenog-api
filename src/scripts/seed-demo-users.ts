import bcrypt from "bcryptjs";
import { Database } from "../config/database.js";
import { logger } from "../core/logger/logger.js";
import { UserModel } from "../modules/user/user.model.js";

const DEMO_PASSWORD = "DemoPass123!";

const demoUsers = [
  { name: "Mavrick Rick", username: "mavrick_rick", email: "demo.mavrick@xenog.local" },
  { name: "Brooklyn Simmons", username: "brooklyn_simmons", email: "demo.brooklyn@xenog.local" },
  { name: "Ketty Perera", username: "ketty_perera", email: "demo.ketty@xenog.local" },
  { name: "Dj Koko", username: "dj_koko", email: "demo.djkoko@xenog.local" },
  { name: "Tuval Mor", username: "tuval_mor", email: "demo.tuval@xenog.local" },
  { name: "Giden Xenog", username: "giden_xenog", email: "demo.giden@xenog.local" },
  { name: "Luna Park", username: "luna_park", email: "demo.luna@xenog.local" },
  { name: "Jacob West", username: "jacob_west", email: "demo.jacob@xenog.local" },
  { name: "Alex Johnson", username: "alex_johnson", email: "demo.alex@xenog.local" },
  { name: "Jane Cooper", username: "jane_cooper", email: "demo.jane@xenog.local" },
  { name: "Cameron Williamson", username: "cameron_w", email: "demo.cameron@xenog.local" },
  { name: "Wade Warren", username: "wade_warren", email: "demo.wade@xenog.local" },
];

const seedDemoUsers = async (): Promise<void> => {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  for (const user of demoUsers) {
    await UserModel.findOneAndUpdate(
      { email: user.email },
      {
        $set: {
          name: user.name,
          username: user.username,
          email: user.email,
          passwordHash,
          accountType: "personal",
          avatarKey: null,
          role: "user",
          isActive: true,
          emailVerified: true,
        },
        $unset: {
          emailVerificationCodeHash: "",
          emailVerificationExpiresAt: "",
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
  }

  logger.info(
    {
      count: demoUsers.length,
      password: DEMO_PASSWORD,
    },
    "Demo users seeded",
  );
};

const run = async (): Promise<void> => {
  await Database.connect();
  await seedDemoUsers();
  await Database.disconnect();
};

void run().catch(async (error) => {
  logger.fatal({ error }, "Failed to seed demo users");
  await Database.disconnect().catch(() => undefined);
  process.exit(1);
});

import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";
import { logger } from "../logger/logger.js";
import { UserModel } from "../../modules/user/user.model.js";

export const seedAdminUser = async (): Promise<void> => {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    logger.warn("Admin seed skipped because ADMIN_EMAIL or ADMIN_PASSWORD is missing");
    return;
  }

  const email = env.ADMIN_EMAIL.toLowerCase();
  const name = env.ADMIN_DISPLAY_NAME ?? "Admin";
  const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
  const existingUser = await UserModel.findOne({ email });

  if (existingUser) {
    await UserModel.updateOne(
      { _id: existingUser._id },
      {
        $set: {
          name,
          passwordHash,
          role: "admin",
          isActive: true,
          emailVerified: true,
        },
        $unset: {
          emailVerificationCodeHash: "",
          emailVerificationExpiresAt: "",
        },
      },
      { runValidators: true },
    );

    logger.info({ email }, "Admin user ensured");
    return;
  }

  await UserModel.create({
    name,
    email,
    passwordHash,
    role: "admin",
    isActive: true,
    emailVerified: true,
  });

  logger.info({ email }, "Admin user seeded");
};
